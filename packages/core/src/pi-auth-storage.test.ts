import { afterEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenHarnessAuthStorage } from "./pi-auth-storage.ts";
import {
  InMemorySecretStore,
  CredentialManager,
  AuthProviderRegistry,
  apiKeyAuthProvider,
  oauthPkceAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";

interface MockIdp {
  tokenEndpoint: string;
  requests: URLSearchParams[];
  hits: () => number;
  close: () => Promise<void>;
}

/** A loopback OAuth token endpoint for exercising the refresh grant. */
async function startMockIdp(
  responder: (params: URLSearchParams, hit: number) => { status: number; body: unknown },
): Promise<MockIdp> {
  const requests: URLSearchParams[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const params = new URLSearchParams(raw);
      requests.push(params);
      const { status, body } = responder(params, requests.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  return {
    tokenEndpoint: `http://127.0.0.1:${port}/token`,
    requests,
    hits: () => requests.length,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let idp: MockIdp | undefined;
afterEach(async () => {
  await idp?.close();
  idp = undefined;
});

function fixture() {
  const accounts: Account[] = [
    { id: "a", provider: "anthropic", authProviderId: "api-key", label: "a", credential: { kind: "api_key", secretRef: "api-key:a" }, health: { state: "ok" } },
    { id: "b", provider: "anthropic", authProviderId: "api-key", label: "b", credential: { kind: "api_key", secretRef: "api-key:b" }, health: { state: "ok" } },
  ];
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["a", "b"] }];
  return { accounts, profiles };
}

test("bridges the CredentialManager into a REAL Pi AuthStorage and rotates the resolved key", async () => {
  const store = new InMemorySecretStore();
  await store.set("api-key:a", "key-a");
  await store.set("api-key:b", "key-b");
  const { accounts, profiles } = fixture();
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));

  const oh = createOpenHarnessAuthStorage({ manager, registry, profile: "work" });
  const providerId = "anthropic";

  await oh.syncActiveProvider(providerId);
  // Real Pi AuthStorage.getApiKey resolves the runtime override we pushed.
  expect(await oh.authStorage.getApiKey(providerId)).toBe("key-a");

  // Rate-limit account a -> next sync must resolve account b's key.
  manager.reportResult("a", { ok: false, kind: "rate_limit", retryAfterMs: 60_000 });
  await oh.syncActiveProvider(providerId);
  expect(await oh.authStorage.getApiKey(providerId)).toBe("key-b");
});

test("multi-key profile: a harness for openai selects the openai key, never the anthropic key", async () => {
  const store = new InMemorySecretStore();
  await store.set("api-key:anth", "key-anthropic");
  await store.set("api-key:oai", "key-openai");
  const accounts: Account[] = [
    { id: "anth", provider: "anthropic", authProviderId: "api-key", label: "anth", credential: { kind: "api_key", secretRef: "api-key:anth" }, health: { state: "ok" } },
    { id: "oai", provider: "openai", authProviderId: "api-key", label: "oai", credential: { kind: "api_key", secretRef: "api-key:oai" }, health: { state: "ok" } },
  ];
  // Both vendors live under one profile (multi-key BYOK); anthropic is first.
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["anth", "oai"] }];
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));

  const oh = createOpenHarnessAuthStorage({ manager, registry, profile: "work" });

  const active = await oh.syncActiveProvider("openai");
  expect(active?.id).toBe("oai");
  // The OpenAI slot gets ONLY the OpenAI key — the anthropic key is never pushed.
  expect(await oh.authStorage.getApiKey("openai")).toBe("key-openai");
  expect(await oh.authStorage.getApiKey("anthropic")).toBeUndefined();
});

test("no account for the harness provider: clears the override, returns undefined, sends no other-provider key", async () => {
  const store = new InMemorySecretStore();
  await store.set("api-key:anth", "key-anthropic");
  const accounts: Account[] = [
    { id: "anth", provider: "anthropic", authProviderId: "api-key", label: "anth", credential: { kind: "api_key", secretRef: "api-key:anth" }, health: { state: "ok" } },
  ];
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["anth"] }];
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));

  const oh = createOpenHarnessAuthStorage({ manager, registry, profile: "work" });

  // Harness provider is openai, but only an anthropic account exists.
  const active = await oh.syncActiveProvider("openai");
  expect(active).toBeUndefined();
  // Clean no-key outcome: no key set for openai, and the anthropic key is NOT
  // leaked onto the openai slot.
  expect(await oh.authStorage.getApiKey("openai")).toBeUndefined();
});

test("clears the override and returns undefined when all accounts are exhausted", async () => {
  const store = new InMemorySecretStore();
  await store.set("api-key:a", "key-a");
  await store.set("api-key:b", "key-b");
  const { accounts, profiles } = fixture();
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));

  const oh = createOpenHarnessAuthStorage({ manager, registry, profile: "work" });
  const providerId = "anthropic";
  manager.reportResult("a", { ok: false, kind: "quota" });
  manager.reportResult("b", { ok: false, kind: "quota" });

  const active = await oh.syncActiveProvider(providerId);
  expect(active).toBeUndefined();
  expect(await oh.authStorage.getApiKey(providerId)).toBeUndefined();
});

test("oauth: an expired token triggers exactly ONE refresh and the refreshed token is used", async () => {
  idp = await startMockIdp((_p, hit) => ({
    status: 200,
    body: { access_token: `refreshed-${hit}`, refresh_token: "rt-rotated", expires_in: 3600 },
  }));
  const store = new InMemorySecretStore();
  await store.set("chatgpt-oauth:o1", "stale-access");
  await store.set("chatgpt-oauth-refresh:o1", "rt-1");
  const NOW = 1_000_000_000;
  const accounts: Account[] = [
    {
      id: "o1",
      provider: "openai",
      authProviderId: "chatgpt-oauth",
      label: "o1",
      credential: {
        kind: "oauth",
        secretRef: "chatgpt-oauth:o1",
        refreshRef: "chatgpt-oauth-refresh:o1",
        expiresAt: NOW - 5_000, // already expired
      },
      health: { state: "ok" },
    },
  ];
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["o1"] }];
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(
    oauthPkceAuthProvider(store, {
      id: "chatgpt-oauth",
      authorizeEndpoint: "https://idp.example/authorize",
      tokenEndpoint: idp.tokenEndpoint,
      clientId: "c",
      now: () => NOW,
    }),
  );

  const oh = createOpenHarnessAuthStorage({ manager, registry, profile: "work", now: () => NOW });

  const active = await oh.syncActiveProvider("openai");
  expect(active?.id).toBe("o1");
  // Exactly one refresh_token exchange hit the token endpoint.
  expect(idp.hits()).toBe(1);
  expect(idp.requests[0].get("grant_type")).toBe("refresh_token");
  expect(idp.requests[0].get("refresh_token")).toBe("rt-1");
  // Pi resolves the REFRESHED token, never the stale one.
  expect(await oh.authStorage.getApiKey("openai")).toBe("refreshed-1");
  // Store updated: access + rotated refresh token persisted.
  expect(await store.get("chatgpt-oauth:o1")).toBe("refreshed-1");
  expect(await store.get("chatgpt-oauth-refresh:o1")).toBe("rt-rotated");
  // A second sync does NOT refresh again — the new expiresAt is well in the future.
  await oh.syncActiveProvider("openai");
  expect(idp.hits()).toBe(1);
});

test("oauth: a refresh REJECTION marks the account invalid and never uses a stale token", async () => {
  idp = await startMockIdp(() => ({ status: 400, body: { error: "invalid_grant" } }));
  const store = new InMemorySecretStore();
  await store.set("chatgpt-oauth:o1", "stale-access");
  await store.set("chatgpt-oauth-refresh:o1", "rt-dead");
  const NOW = 2_000_000_000;
  const accounts: Account[] = [
    {
      id: "o1",
      provider: "openai",
      authProviderId: "chatgpt-oauth",
      label: "o1",
      credential: {
        kind: "oauth",
        secretRef: "chatgpt-oauth:o1",
        refreshRef: "chatgpt-oauth-refresh:o1",
        expiresAt: NOW - 5_000,
      },
      health: { state: "ok" },
    },
  ];
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["o1"] }];
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(
    oauthPkceAuthProvider(store, {
      id: "chatgpt-oauth",
      authorizeEndpoint: "https://idp.example/authorize",
      tokenEndpoint: idp.tokenEndpoint,
      clientId: "c",
      now: () => NOW,
    }),
  );

  const oh = createOpenHarnessAuthStorage({ manager, registry, profile: "work", now: () => NOW });

  await expect(oh.syncActiveProvider("openai")).rejects.toThrow(/refresh/i);
  // The stale access token was NEVER pushed to Pi.
  expect(await oh.authStorage.getApiKey("openai")).toBeUndefined();
  // Account marked invalid -> rotation basis: no healthy openai account remains.
  expect(manager.activeAccount("work", "openai")).toBeUndefined();
});
