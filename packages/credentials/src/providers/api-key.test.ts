import { expect, test } from "vitest";
import { apiKeyAuthProvider } from "./api-key.ts";
import { InMemorySecretStore } from "../secret-store.ts";

test("api-key: authorize asks to paste a key", async () => {
  const p = apiKeyAuthProvider(new InMemorySecretStore());
  const a = await p.authorize();
  expect(a.method).toBe("paste");
});

test("api-key: callback stores the secret and returns metadata-only credential", async () => {
  const store = new InMemorySecretStore();
  const p = apiKeyAuthProvider(store);
  const cred = await p.callback({ accountId: "go-1", apiKey: "oc_live_x", baseUrl: "https://opencode.ai/zen/go/v1" });
  expect(cred.kind).toBe("api_key");
  expect(cred.baseUrl).toBe("https://opencode.ai/zen/go/v1");
  expect(await store.get(cred.secretRef)).toBe("oc_live_x"); // secret in store, not in cred
  expect(JSON.stringify(cred)).not.toContain("oc_live_x");
});

test("api-key: applyToRequest injects key + baseUrl", async () => {
  const store = new InMemorySecretStore();
  const p = apiKeyAuthProvider(store);
  const cred = await p.callback({ accountId: "go-1", apiKey: "oc_live_x", baseUrl: "https://opencode.ai/zen/go/v1" });
  const req = await p.applyToRequest(cred, { headers: {} });
  expect(req.apiKey).toBe("oc_live_x");
  expect(req.baseUrl).toBe("https://opencode.ai/zen/go/v1");
});

test("api-key: callback rejects an empty key", async () => {
  const p = apiKeyAuthProvider(new InMemorySecretStore());
  await expect(p.callback({ accountId: "x", apiKey: "" })).rejects.toThrow();
});
