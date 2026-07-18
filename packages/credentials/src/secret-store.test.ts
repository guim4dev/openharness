import { expect, test } from "vitest";
import { mkdtemp, rm, chmod, readFile, writeFile, readdir } from "node:fs/promises";
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

test("open() REFUSES to regenerate the key when it exists but is unreadable (no silent data destruction)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sec-keyerr-"));
  try {
    const a = await EncryptedFileSecretStore.open(dir);
    await a.set("acct-1", "sk-secret");
    const keyBefore = await readFile(join(dir, "secret.key"), "utf8");
    // Simulate a transient non-ENOENT read failure (write-only key file).
    await chmod(join(dir, "secret.key"), 0o200);
    await expect(EncryptedFileSecretStore.open(dir)).rejects.toThrow(/could not be read|refusing to regenerate/i);
    // The original key was NOT overwritten.
    await chmod(join(dir, "secret.key"), 0o600);
    expect(await readFile(join(dir, "secret.key"), "utf8")).toBe(keyBefore);
    // And the secret is still decryptable.
    expect(await (await EncryptedFileSecretStore.open(dir)).get("acct-1")).toBe("sk-secret");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("open() REFUSES to start empty when secrets.enc is present but corrupt (no silent secret drop)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sec-corrupt-"));
  try {
    const a = await EncryptedFileSecretStore.open(dir);
    await a.set("acct-1", "sk-secret");
    await writeFile(join(dir, "secrets.enc"), "{ this is not valid json");
    await expect(EncryptedFileSecretStore.open(dir)).rejects.toThrow(/could not be read or parsed|refusing to start with an empty/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("flush is atomic (temp+rename) and leaves no stray temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sec-atomic-"));
  try {
    const s = await EncryptedFileSecretStore.open(dir);
    await s.set("a", "1");
    await s.set("b", "2");
    const entries = await readdir(dir);
    expect(entries.some((f) => f.includes(".tmp-"))).toBe(false); // no leftover temp
    const reopened = await EncryptedFileSecretStore.open(dir);
    expect(await reopened.get("a")).toBe("1");
    expect(await reopened.get("b")).toBe("2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
