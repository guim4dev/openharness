import { afterEach, beforeEach, expect, test } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  AuthProviderRegistry,
  apiKeyAuthProvider,
  CredentialManager,
  InMemorySecretStore,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";
import type { McpConnection } from "@openharness/mcp";
import { createLiveSession } from "./live-session.ts";
import type { GatewayAuth } from "./gateway-bridge.ts";
import { createStubModelRegistry } from "./testing.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oh-live-gw-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Write a minimal harness that DECLARES a remote gateway. */
async function gatewayHarness(): Promise<string> {
  const manifest = {
    name: "gw-harness",
    version: "0.1.0",
    branding: { displayName: "Gateway Assistant", accent: "#4F46E5" },
    systemPrompt: "system-prompt.md",
    skills: [],
    providers: { default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" } },
    gateway: { url: "https://gw.acme.internal/mcp", pubkey: "PINNED_PUBKEY_PEM", tools: ["github__list_issues"] },
  };
  await writeFile(join(tmp, "harness.json"), JSON.stringify(manifest), "utf8");
  await writeFile(join(tmp, "system-prompt.md"), "You are a governed assistant.", "utf8");
  return tmp;
}

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

const FAKE_AUTH: GatewayAuth = { token: "t", clientPublicKey: "pub", clientPrivateKey: "priv" };

async function commonOpts() {
  const { store, manager, registry } = buildCredentials();
  await store.set("api-key:a", "key-a");
  return {
    harnessPath: await gatewayHarness(),
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    modelRegistryOverride: createStubModelRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      reply: "ok",
    }),
  };
}

test("fail-closed: a harness declaring a gateway refuses to boot without gatewayAuth", async () => {
  const opts = await commonOpts();
  await expect(createLiveSession(opts)).rejects.toThrow(/gateway.*no gatewayAuth|refusing to boot/i);
});

test("with gatewayAuth, the declared gateway's tools are bridged into the session and disposed on close", async () => {
  const opts = await commonOpts();

  let listed = 0;
  let closed = 0;
  const fakeConn: McpConnection = {
    listTools: async () => {
      listed++;
      return [{ name: "github__list_issues", description: "list", inputSchema: { type: "object", properties: {} } }];
    },
    callTool: async () => ({ content: [{ type: "text", text: "[]" }] }),
    close: async () => {
      closed++;
    },
  };

  const live = await createLiveSession({
    ...opts,
    gatewayAuth: FAKE_AUTH,
    gatewayOptions: { connect: async () => fakeConn },
  });

  // The bridge ran during boot (connected + enumerated the pinned catalog).
  expect(listed).toBe(1);

  await live.close();
  // The gateway connection is disposed with the session.
  expect(closed).toBe(1);
});
