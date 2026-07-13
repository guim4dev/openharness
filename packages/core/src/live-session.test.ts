import { afterEach, beforeEach, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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
import { createStubModelRegistry } from "./testing.ts";

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
