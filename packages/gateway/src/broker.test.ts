import { expect, test } from "vitest";
import { InMemorySecretStore } from "@openharness/credentials";
import { SecretStoreKms } from "./broker.ts";

test("resolves the org's per-upstream credential from the store", async () => {
  const store = new InMemorySecretStore();
  await store.set("upstream:github", "ghp_orgtoken");
  const kms = new SecretStoreKms(store);
  const cred = await kms.resolve("github");
  expect(cred?.secret).toBe("ghp_orgtoken");
});

test("returns undefined for an upstream with no stored credential", async () => {
  const kms = new SecretStoreKms(new InMemorySecretStore());
  expect(await kms.resolve("unknown")).toBeUndefined();
});

test("attaches non-secret metadata but never the secret in meta", async () => {
  const store = new InMemorySecretStore();
  await store.set("upstream:pg", "conn-secret");
  const kms = new SecretStoreKms(store, (id) => (id === "pg" ? { baseUrl: "https://db.internal" } : undefined));
  const cred = await kms.resolve("pg");
  expect(cred?.secret).toBe("conn-secret");
  expect(cred?.meta).toEqual({ baseUrl: "https://db.internal" });
  expect(JSON.stringify(cred?.meta)).not.toContain("conn-secret");
});

test("upstream secrets live in a namespace disjoint from api-key:* (no cross-read)", async () => {
  const store = new InMemorySecretStore();
  await store.set("api-key:gui-anthropic", "sk-llm-key");
  const kms = new SecretStoreKms(store);
  // Resolving an upstream id must NOT return the LLM key, even if ids collide.
  expect(await kms.resolve("gui-anthropic")).toBeUndefined();
});
