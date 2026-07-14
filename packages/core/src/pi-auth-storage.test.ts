import { expect, test } from "vitest";
import { createOpenHarnessAuthStorage } from "./pi-auth-storage.ts";
import {
  InMemorySecretStore,
  CredentialManager,
  AuthProviderRegistry,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";

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
