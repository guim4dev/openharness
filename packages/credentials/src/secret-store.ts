import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, access, chmod } from "node:fs/promises";
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
      await access(keyFile);
      key = Buffer.from(await readFile(keyFile, "utf8"), "base64");
    } catch {
      key = randomBytes(32);
      await writeFile(keyFile, key.toString("base64"), { mode: 0o600 });
      await chmod(keyFile, 0o600);
    }
    const file = join(dir, "secrets.enc");
    let data: Record<string, { iv: string; tag: string; data: string }> = {};
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch {
      /* new store */
    }
    return new EncryptedFileSecretStore(key, file, data);
  }

  private async flush() {
    await writeFile(this.file, JSON.stringify(this.data), { mode: 0o600 });
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
