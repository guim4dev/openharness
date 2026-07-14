import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { configDir } from "./paths.ts";
import { startSession } from "./session.ts";
import {
  InMemorySecretStore,
  CredentialManager,
  AuthProviderRegistry,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";

const here = dirname(fileURLToPath(import.meta.url));
const exampleHarness = join(here, "..", "..", "..", "harnesses", "example");

test("configDir is absolute and namespaced", () => {
  expect(isAbsolute(configDir())).toBe(true);
  expect(configDir().endsWith("openharness")).toBe(true);
});

test("rotates to the next account when the first hits a rate limit, then succeeds", async () => {
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

  // Stub model provider: first call with key-a returns a 429; any other key returns text.
  const stub: import("./session.ts").ModelProvider = {
    async streamSimple(_model, _ctx, options) {
      if (options.apiKey === "key-a") {
        const err = new Error("429 rate_limit");
        (err as { status?: number }).status = 429;
        throw err;
      }
      return { text: "hello from stub" };
    },
  };

  const session = await startSession({
    harnessPath: exampleHarness,
    manager,
    registry,
    secretStore: store,
    modelProvider: stub,
  });
  const res = await session.prompt("hi");
  expect(res.text).toContain("hello from stub");
  expect(res.rotations).toBe(1); // rotated a -> b once
  expect(manager.activeAccount("work")?.id).toBe("b");
});
