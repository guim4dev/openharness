import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccounts, persistOnboardedAccount } from "./accounts.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oh-accounts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("maps ENV keys to accounts under the given profile; secrets live only in the store", async () => {
  const { manager, secretStore } = await loadAccounts({
    profileName: "work",
    dir,
    env: { ANTHROPIC_API_KEY: "sk-ant-SECRET", OPENAI_API_KEY: "sk-oai-SECRET" },
  });

  // Anthropic is highest priority, so it is the active account under "work".
  const active = manager.activeAccount("work");
  expect(active).toBeDefined();
  expect(active?.authProviderId).toBe("api-key");

  // The secret is retrievable from the store...
  expect(await secretStore.get(active!.credential.secretRef)).toBe("sk-ant-SECRET");
  // ...but never lives on the returned account object graph.
  expect(JSON.stringify(active)).not.toContain("sk-ant-SECRET");
  expect(active!.credential).not.toHaveProperty("apiKey");

  // The second env key is also present in the store as its own account.
  const both = await loadAccounts({
    profileName: "work",
    dir,
    env: { OPENAI_API_KEY: "sk-oai-SECRET" },
  });
  const oai = both.manager.activeAccount("work");
  expect(await both.secretStore.get(oai!.credential.secretRef)).toBe("sk-oai-SECRET");
});

test("reads accounts.json profiles/accounts; apiKey (literal) and apiKeyEnv both resolve into the encrypted store only", async () => {
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify({
      profiles: {
        team: {
          policy: "failover",
          accounts: [
            { id: "acct-lit", provider: "anthropic", authProviderId: "api-key", label: "literal", apiKey: "sk-lit-SECRET" },
            {
              id: "acct-env",
              provider: "openai",
              authProviderId: "api-key",
              label: "from-env",
              apiKeyEnv: "MY_OPENAI",
              baseUrl: "https://example.test/v1",
            },
          ],
        },
      },
    }),
  );

  const { manager, secretStore } = await loadAccounts({
    profileName: "work",
    dir,
    env: { MY_OPENAI: "sk-env-SECRET" },
  });

  // failover -> first account in the file profile is active.
  const active = manager.activeAccount("team");
  expect(active?.id).toBe("acct-lit");

  // Both the literal key and the env-referenced key landed in the store.
  expect(await secretStore.get("api-key:acct-lit")).toBe("sk-lit-SECRET");
  expect(await secretStore.get("api-key:acct-env")).toBe("sk-env-SECRET");

  // Returned account JSON never contains raw key material.
  expect(JSON.stringify(active)).not.toContain("sk-lit-SECRET");

  // The on-disk secrets file is encrypted: the plaintext key is not present.
  const enc = await readFile(join(dir, "secrets", "secrets.enc"), "utf8");
  expect(enc).not.toContain("sk-lit-SECRET");
  expect(enc).not.toContain("sk-env-SECRET");
});

test("durable onboarding: a keyless accounts.json entry resolves from an already-stored secret", async () => {
  // First load creates the encrypted store; stash a secret as in-app onboarding would.
  const first = await loadAccounts({ profileName: "work", dir, env: {} });
  await first.secretStore.set("api-key:gui-anthropic", "sk-stored-SECRET");
  // Persist a KEYLESS entry (no apiKey) referencing that stored secret.
  await persistOnboardedAccount({ dir, profileName: "work", id: "gui-anthropic", provider: "anthropic" });

  // Reload (next launch): the keyless entry resolves from the store.
  const second = await loadAccounts({ profileName: "work", dir, env: {} });
  const active = second.manager.activeAccount("work", "anthropic");
  expect(active?.id).toBe("gui-anthropic");
  expect(await second.secretStore.get(active!.credential.secretRef)).toBe("sk-stored-SECRET");
  // accounts.json never holds the raw key.
  expect(await readFile(join(dir, "accounts.json"), "utf8")).not.toContain("sk-stored-SECRET");
});

test("a keyless accounts.json entry with no stored secret is skipped (unresolved)", async () => {
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify({ profiles: { work: { accounts: [{ id: "ghost", provider: "anthropic" }] } } }),
  );
  const { manager } = await loadAccounts({ profileName: "work", dir, env: {} });
  expect(manager.activeAccount("work", "anthropic")).toBeUndefined();
});

test("persistOnboardedAccount merges into an existing accounts.json without clobbering or storing a key", async () => {
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify({
      profiles: { work: { policy: "failover", accounts: [{ id: "existing", provider: "openai", apiKey: "sk-x" }] } },
    }),
  );
  await persistOnboardedAccount({ dir, profileName: "work", id: "gui-anthropic", provider: "anthropic" });

  const file = JSON.parse(await readFile(join(dir, "accounts.json"), "utf8")) as {
    profiles: Record<string, { accounts: { id: string; apiKey?: string }[] }>;
  };
  const accts = file.profiles.work.accounts;
  expect(accts.map((a) => a.id).sort()).toEqual(["existing", "gui-anthropic"]);
  // The onboarded entry carries no key — the secret stays in the encrypted store.
  expect(accts.find((a) => a.id === "gui-anthropic")?.apiKey).toBeUndefined();
});

test("env-derived default profile and file-defined profiles coexist in one manager", async () => {
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify({
      profiles: {
        team: {
          policy: "failover",
          accounts: [{ id: "t1", provider: "anthropic", label: "t1", apiKey: "sk-team-SECRET" }],
        },
      },
    }),
  );

  const { manager } = await loadAccounts({
    profileName: "work",
    dir,
    env: { ANTHROPIC_API_KEY: "sk-work-SECRET" },
  });

  expect(manager.activeAccount("work")).toBeDefined(); // from env
  expect(manager.activeAccount("team")?.id).toBe("t1"); // from file
});
