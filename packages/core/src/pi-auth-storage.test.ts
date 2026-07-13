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
    { id: "a", authProviderId: "api-key", label: "a", credential: { kind: "api_key", secretRef: "api-key:a" }, health: { state: "ok" } },
    { id: "b", authProviderId: "api-key", label: "b", credential: { kind: "api_key", secretRef: "api-key:b" }, health: { state: "ok" } },
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
