import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, chmod, rename } from "node:fs/promises";
import { join } from "node:path";

export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  async get(ref: string) {
    return this.m.get(ref);
  }
  async set(ref: string, secret: string) {
    this.m.set(ref, secret);
  }
  async delete(ref: string) {
    this.m.delete(ref);
  }
}

/**
 * AES-256-GCM file store. The 32-byte key lives in `<dir>/secret.key` (0600).
 * Secrets live in `<dir>/secrets.enc` as JSON { ref: {iv, tag, data} } (base64).
 * Phase-1 backend; OS keychain backend is a later phase.
 */
export class EncryptedFileSecretStore implements SecretStore {
  private constructor(
    private key: Buffer,
    private file: string,
    private data: Record<string, { iv: string; tag: string; data: string }>,
  ) {}

  static async open(dir: string): Promise<EncryptedFileSecretStore> {
    await mkdir(dir, { recursive: true });
    const keyFile = join(dir, "secret.key");
    let key: Buffer;
    try {
      key = Buffer.from(await readFile(keyFile, "utf8"), "base64");
    } catch (e) {
      // ONLY generate a new key when the file genuinely does not exist. A key
      // that exists but is momentarily unreadable (EACCES/EBUSY/EIO — an AV or
      // backup lock, a perms change, a concurrent writer) must NOT be
      // regenerated: overwriting it would permanently destroy the ability to
      // decrypt every stored secret. Fail loud instead.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `secret key at ${keyFile} exists but could not be read — refusing to regenerate it (that would permanently destroy every stored secret): ${(e as Error).message}`,
        );
      }
      key = randomBytes(32);
      await writeFile(keyFile, key.toString("base64"), { mode: 0o600 });
      await chmod(keyFile, 0o600);
    }
    const file = join(dir, "secrets.enc");
    let data: Record<string, { iv: string; tag: string; data: string }> = {};
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      // A MISSING file is a genuine new store. A file that exists but is
      // unreadable or corrupt must NOT be treated as empty — starting empty and
      // letting the next set() flush over it would silently drop every secret.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `secrets store at ${file} exists but could not be read or parsed — refusing to start with an empty store (the next write would drop every secret): ${(e as Error).message}`,
        );
      }
      /* ENOENT → a genuinely new store */
    }
    return new EncryptedFileSecretStore(key, file, data);
  }

  private async flush() {
    // Atomic write: a crash or concurrent write mid-flush must not truncate/
    // corrupt the whole store. Write a temp file, then rename over the target
    // (atomic on the same filesystem — the temp lives in the same dir).
    const tmp = `${this.file}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async get(ref: string) {
    const e = this.data[ref];
    if (!e) return undefined;
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(e.iv, "base64"));
    d.setAuthTag(Buffer.from(e.tag, "base64"));
    return d.update(Buffer.from(e.data, "base64"), undefined, "utf8") + d.final("utf8");
  }
  async set(ref: string, secret: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(secret, "utf8"), c.final()]);
    this.data[ref] = {
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    await this.flush();
  }
  async delete(ref: string) {
    delete this.data[ref];
    await this.flush();
  }
}
