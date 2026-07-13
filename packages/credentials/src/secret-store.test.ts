import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySecretStore, EncryptedFileSecretStore } from "./secret-store.ts";

test("in-memory store round-trips a secret", async () => {
  const s = new InMemorySecretStore();
  await s.set("acct-1", "sk-abc");
  expect(await s.get("acct-1")).toBe("sk-abc");
  await s.delete("acct-1");
  expect(await s.get("acct-1")).toBeUndefined();
});

test("encrypted-file store persists and decrypts across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sec-"));
  try {
    const a = await EncryptedFileSecretStore.open(dir);
    await a.set("acct-1", "sk-secret");
    const b = await EncryptedFileSecretStore.open(dir); // reopen
    expect(await b.get("acct-1")).toBe("sk-secret");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
