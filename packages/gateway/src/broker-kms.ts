import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsStore, UpstreamCredential } from "./broker.ts";

/**
 * Deploy hardening §4 (recommended option A): a KMS-backed credential broker.
 * The secrets manager stores the org's per-upstream secret ALREADY WRAPPED by a
 * KMS key; the KMS is the only thing that can unwrap it, and every unwrap is an
 * audited decrypt call. The gateway therefore holds NO long-lived plaintext —
 * each `resolve` fetches the wrapped blob, does one KMS decrypt, and the
 * plaintext exists only for the life of the single connector call that needs it.
 * Rotation happens out-of-band in the secrets manager; the gateway simply sees
 * the new blob on the next resolve.
 *
 * Both seams are provider-agnostic. A deployment wires ONE `KmsClient` (AWS KMS /
 * GCP KMS / Vault transit) and ONE `SecretsManager` (AWS Secrets Manager / GCP
 * Secret Manager / Vault KV) — the governed pipeline is unchanged, since
 * `KmsStore.resolve` is the only seam it touches.
 */

/**
 * A KMS-wrapped secret as the secrets manager stores it. The plaintext NEVER
 * lives here — only the ciphertext, which KMS key unwraps it, the encryption
 * context bound into that decrypt, and non-secret metadata a connector may need.
 */
export interface WrappedSecret {
  /** Which KMS key unwraps this blob. */
  keyId: string;
  /** The KMS-wrapped secret bytes (opaque to the gateway). */
  ciphertext: Uint8Array;
  /**
   * Additional authenticated data the KMS binds into the decrypt — typically
   * pins the blob to its upstream so a blob for one upstream cannot be unwrapped
   * under another's context. A mismatch fails the decrypt.
   */
  encryptionContext?: Record<string, string>;
  /** Non-secret metadata (base URL, username, …) handed alongside the secret. */
  meta?: Record<string, string>;
}

/**
 * Where the KMS-wrapped blob is stored. Production: AWS Secrets Manager, GCP
 * Secret Manager, or a Vault KV engine — an authenticated fetch keyed by upstream.
 */
export interface SecretsManager {
  fetch(upstreamId: string): Promise<WrappedSecret | undefined>;
}

/**
 * The KMS seam: the ONLY component that can turn ciphertext into plaintext, and
 * the one auditable decrypt call. Production: AWS KMS, GCP KMS, or Vault transit —
 * the key never leaves the KMS; only `decrypt` is exposed to the gateway.
 */
export interface KmsClient {
  decrypt(input: {
    keyId: string;
    ciphertext: Uint8Array;
    encryptionContext?: Record<string, string>;
  }): Promise<Uint8Array>;
}

export class KmsBrokerStore implements KmsStore {
  constructor(
    private readonly secrets: SecretsManager,
    private readonly kms: KmsClient,
  ) {}

  async resolve(upstreamId: string): Promise<UpstreamCredential | undefined> {
    const wrapped = await this.secrets.fetch(upstreamId);
    if (!wrapped) return undefined;
    const plaintext = await this.kms.decrypt({
      keyId: wrapped.keyId,
      ciphertext: wrapped.ciphertext,
      ...(wrapped.encryptionContext ? { encryptionContext: wrapped.encryptionContext } : {}),
    });
    const secret = Buffer.from(plaintext).toString("utf8");
    return wrapped.meta ? { secret, meta: wrapped.meta } : { secret };
  }
}

/** Canonical AAD bytes for an encryption context: key-sorted JSON, or empty. */
function aadBytes(ctx: Record<string, string> | undefined): Buffer | undefined {
  if (!ctx) return undefined;
  const keys = Object.keys(ctx).sort();
  if (keys.length === 0) return undefined;
  return Buffer.from(JSON.stringify(keys.map((k) => [k, ctx[k]])));
}

/**
 * A local, offline reference KMS for dev and tests. Master keys are held in
 * memory by `keyId`; decrypt is real AES-256-GCM with the encryption context
 * bound as AAD. It models a cloud KMS faithfully — the key stays "server-side"
 * (never returned) and only encrypt/decrypt are exposed — so the exact same
 * `KmsBrokerStore` wiring runs against AWS/GCP/Vault in production.
 *
 * The GCM ciphertext layout is `iv(12) || tag(16) || data`.
 */
export class LocalKms implements KmsClient {
  private readonly keys = new Map<string, Buffer>();

  /** Provision a master key (production: created out-of-band in the cloud KMS). */
  createKey(keyId: string): void {
    if (!this.keys.has(keyId)) this.keys.set(keyId, randomBytes(32));
  }

  /**
   * Wrap a plaintext under a key. A SEED/TEST helper — in production the operator
   * encrypts the secret out-of-band and stores the blob in the secrets manager;
   * the gateway only ever decrypts.
   */
  encrypt(input: { keyId: string; plaintext: string; encryptionContext?: Record<string, string> }): Uint8Array {
    const key = this.mustKey(input.keyId);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const aad = aadBytes(input.encryptionContext);
    if (aad) c.setAAD(aad);
    const data = Buffer.concat([c.update(input.plaintext, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]);
  }

  async decrypt(input: {
    keyId: string;
    ciphertext: Uint8Array;
    encryptionContext?: Record<string, string>;
  }): Promise<Uint8Array> {
    const key = this.mustKey(input.keyId);
    const buf = Buffer.from(input.ciphertext);
    if (buf.length < 12 + 16) throw new Error("kms: ciphertext too short");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    const aad = aadBytes(input.encryptionContext);
    if (aad) d.setAAD(aad);
    return Buffer.concat([d.update(data), d.final()]);
  }

  private mustKey(keyId: string): Buffer {
    const k = this.keys.get(keyId);
    if (!k) throw new Error(`kms: unknown keyId ${keyId}`);
    return k;
  }
}

/**
 * A local, offline reference secrets manager for dev and tests: wrapped blobs
 * held in memory by upstream id. Production swaps a real secrets manager behind
 * the `SecretsManager` interface.
 */
export class InMemorySecretsManager implements SecretsManager {
  private readonly store = new Map<string, WrappedSecret>();

  put(upstreamId: string, wrapped: WrappedSecret): void {
    this.store.set(upstreamId, wrapped);
  }

  async fetch(upstreamId: string): Promise<WrappedSecret | undefined> {
    return this.store.get(upstreamId);
  }
}
