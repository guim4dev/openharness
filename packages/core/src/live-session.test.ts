import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import {
  InMemorySecretStore,
  CredentialManager,
  AuthProviderRegistry,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";
import { createLiveSession } from "./live-session.ts";
import type { LiveSessionEvent } from "./live-session.ts";
import { createFailThenReplyStubModelRegistry, createStubModelRegistry } from "./testing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleHarness = join(here, "..", "..", "..", "harnesses", "example");

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oh-live-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function buildCredentials() {
  const store = new InMemorySecretStore();
  const accounts: Account[] = [
    {
      id: "a",
      provider: "anthropic",
      authProviderId: "api-key",
      label: "a",
      credential: { kind: "api_key", secretRef: "api-key:a" },
      health: { state: "ok" },
    },
  ];
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["a"] }];
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));
  return { store, manager, registry };
}

test("streams token deltas and a final done from a stubbed Pi provider, offline", async () => {
  const { store, manager, registry } = buildCredentials();
  await store.set("api-key:a", "key-a");

  const live = await createLiveSession({
    harnessPath: exampleHarness,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    // Bind the stub provider to the SAME AuthStorage the session builds, and
    // register it under the harness's provider/model so the turn routes to it.
    modelRegistryOverride: createStubModelRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      reply: "canned reply from stub",
    }),
  });

  try {
    const events: LiveSessionEvent[] = [];
    await live.prompt("hello", (e) => events.push(e));

    const tokens = events.filter((e) => e.type === "token").map((e) => e.text);
    expect(tokens.length).toBeGreaterThan(1); // streamed, not one shot
    expect(tokens.join("")).toContain("canned reply from stub");

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect((done as Extract<LiveSessionEvent, { type: "done" }>).text).toContain(
      "canned reply from stub",
    );

    expect(events.some((e) => e.type === "error")).toBe(false);
    // token events precede the done event
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    await live.close();
  }
});

test("rotates to the next account on a live rate-limit and still answers", async () => {
  const store = new InMemorySecretStore();
  await store.set("api-key:a", "key-a");
  await store.set("api-key:b", "key-b");
  const accounts: Account[] = [
    {
      id: "a",
      provider: "anthropic",
      authProviderId: "api-key",
      label: "a",
      credential: { kind: "api_key", secretRef: "api-key:a" },
      health: { state: "ok" },
    },
    {
      id: "b",
      provider: "anthropic",
      authProviderId: "api-key",
      label: "b",
      credential: { kind: "api_key", secretRef: "api-key:b" },
      health: { state: "ok" },
    },
  ];
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["a", "b"] }];
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));

  const live = await createLiveSession({
    harnessPath: exampleHarness,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    modelRegistryOverride: createFailThenReplyStubModelRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      failErrorMessage: "rate limit exceeded (429)",
      reply: "answer after rotation",
    }),
  });

  try {
    const events: LiveSessionEvent[] = [];
    await live.prompt("hello", (e) => events.push(e));

    // Recovered: the reply came through and no error surfaced to the caller.
    const done = events.find((e) => e.type === "done") as
      | Extract<LiveSessionEvent, { type: "done" }>
      | undefined;
    expect(done?.text).toContain("answer after rotation");
    expect(events.some((e) => e.type === "error")).toBe(false);
    // The failed attempt streamed no tokens, so the reply isn't duplicated.
    expect(events.filter((e) => e.type === "token").map((e) => e.text).join("")).toContain(
      "answer after rotation",
    );

    // Rotation actually happened: account a was marked rate-limited, so b is active.
    expect(manager.activeAccount("work", "anthropic")?.id).toBe("b");
  } finally {
    await live.close();
  }
});

test("close() completes the final audit flush even when a teardown step (gateway dispose) throws — no orphaned steps", async () => {
  // A tiny audit-ingest server so the final flush yields a result (onShipResult).
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ackedSeq: -1 }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;

  // A harness that declares BOTH a gateway (whose close() we make reject) and a
  // policy (so an audit sink + shipper exist).
  const hdir = join(tmp, "gwharness");
  await mkdir(hdir, { recursive: true });
  await writeFile(join(hdir, "system-prompt.md"), "You are governed.\n");
  await writeFile(join(hdir, "policy.json"), JSON.stringify({ default: "allow", rules: [] }));
  await writeFile(
    join(hdir, "harness.json"),
    JSON.stringify({
      name: "gw",
      version: "0.1.0",
      branding: { displayName: "GW" },
      systemPrompt: "system-prompt.md",
      skills: [],
      providers: { default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" } },
      gateway: { url: `http://127.0.0.1:${port}/mcp`, pubkey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----", tools: [] },
    }),
  );

  const { store, manager, registry } = buildCredentials();
  await store.set("api-key:a", "key-a");
  const onShipResult = vi.fn();

  const live = await createLiveSession({
    harnessPath: hdir,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    modelRegistryOverride: createStubModelRegistry({ provider: "anthropic", modelId: "claude-sonnet-5", reply: "x" }),
    auditPath: join(tmp, "audit.jsonl"),
    auditServer: { url: `http://127.0.0.1:${port}`, source: "s", onShipResult },
    // Presence-checked (fail-closed) but unused here — connect is stubbed below.
    gatewayAuth: { token: "t", clientPublicKey: "p", clientPrivateKey: "k" },
    // The gateway "connects" (listTools succeeds) but its close() rejects — the
    // exact teardown-failure that previously aborted the rest of close().
    gatewayOptions: {
      connect: async () =>
        ({
          listTools: async () => [],
          callTool: async () => ({ content: [] }),
          close: async () => {
            throw new Error("gateway transport already gone");
          },
        }) as never,
    },
  });

  try {
    // The gateway dispose rejects, so close() surfaces that error — but ONLY after
    // running the remaining teardown (the final flush still fires onShipResult).
    await expect(live.close()).rejects.toThrow(/already gone/);
    expect(onShipResult).toHaveBeenCalled();
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
