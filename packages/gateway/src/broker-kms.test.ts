import { expect, test } from "vitest";
import { InMemorySecretsManager, KmsBrokerStore, LocalKms } from "./broker-kms.ts";

/** Seed a KMS-wrapped secret into a secrets manager, pinned to its upstream. */
function seed(kms: LocalKms, sm: InMemorySecretsManager, upstreamId: string, secret: string, meta?: Record<string, string>) {
  const keyId = "org/upstreams";
  kms.createKey(keyId);
  const ctx = { upstreamId };
  const ciphertext = kms.encrypt({ keyId, plaintext: secret, encryptionContext: ctx, ...(meta ? { meta } : {}) });
  sm.put(upstreamId, { keyId, ciphertext, encryptionContext: ctx, ...(meta ? { meta } : {}) });
}

test("resolve fetches the wrapped blob and returns the KMS-decrypted secret + meta", async () => {
  const kms = new LocalKms();
  const sm = new InMemorySecretsManager();
  seed(kms, sm, "github", "ghp_orgtoken", { baseUrl: "https://api.github.com" });

  const broker = new KmsBrokerStore(sm, kms);
  const cred = await broker.resolve("github");
  expect(cred?.secret).toBe("ghp_orgtoken");
  expect(cred?.meta).toEqual({ baseUrl: "https://api.github.com" });
});

test("an unknown upstream resolves to undefined (no blob, no KMS call)", async () => {
  const broker = new KmsBrokerStore(new InMemorySecretsManager(), new LocalKms());
  expect(await broker.resolve("nope")).toBeUndefined();
});

test("the gateway never holds a decryptable copy — only the KMS unwraps, and only for the pinned context", async () => {
  const kms = new LocalKms();
  const sm = new InMemorySecretsManager();
  seed(kms, sm, "github", "ghp_orgtoken");

  // The stored blob is opaque ciphertext — it is NOT the plaintext.
  const stored = await sm.fetch("github");
  expect(Buffer.from(stored!.ciphertext).toString("utf8")).not.toContain("ghp_orgtoken");

  // Decrypting under a DIFFERENT upstream's context fails: the blob is bound to
  // its own upstream, so a mixed-up / swapped blob can't be unwrapped elsewhere.
  await expect(
    kms.decrypt({ keyId: stored!.keyId, ciphertext: stored!.ciphertext, encryptionContext: { upstreamId: "evil" } }),
  ).rejects.toThrow();
});

test("a tampered ciphertext fails the KMS decrypt (GCM auth), never yielding a forged secret", async () => {
  const kms = new LocalKms();
  const sm = new InMemorySecretsManager();
  seed(kms, sm, "github", "ghp_orgtoken");
  const stored = await sm.fetch("github");
  const tampered = Buffer.from(stored!.ciphertext);
  tampered[tampered.length - 1] ^= 0xff; // flip a byte of the payload
  sm.put("github", { ...stored!, ciphertext: tampered });

  const broker = new KmsBrokerStore(sm, kms);
  await expect(broker.resolve("github")).rejects.toThrow();
});

test("tampering with meta (e.g. redirecting baseUrl) fails the decrypt — meta is authenticated, not just the ciphertext", async () => {
  const kms = new LocalKms();
  const sm = new InMemorySecretsManager();
  seed(kms, sm, "github", "ghp_orgtoken", { baseUrl: "https://api.github.com" });

  // Attacker with secrets-manager write keeps the valid ciphertext + context but
  // repoints baseUrl to their host. Because meta is folded into the AAD, the
  // GCM auth now fails instead of handing the real token to the attacker URL.
  const stored = await sm.fetch("github");
  sm.put("github", { ...stored!, meta: { baseUrl: "https://evil.attacker.example" } });

  const broker = new KmsBrokerStore(sm, kms);
  await expect(broker.resolve("github")).rejects.toThrow();
});

test("a non-string encryption-context value fails closed (mistyped/adversarial secrets manager)", async () => {
  const kms = new LocalKms();
  kms.createKey("k");
  // A SecretsManager that violates Record<string,string> must not create an AAD collision.
  expect(() =>
    kms.encrypt({ keyId: "k", plaintext: "s", encryptionContext: { u: null as unknown as string } }),
  ).toThrow(/must be strings/);
});

test("an empty encryption context is omitted from the KMS call, not passed as {}", async () => {
  const kms = new LocalKms();
  kms.createKey("k");
  const seen: Array<Record<string, string> | undefined> = [];
  const spy = { async decrypt(i: { keyId: string; ciphertext: Uint8Array; encryptionContext?: Record<string, string> }) {
    seen.push(i.encryptionContext);
    return kms.decrypt(i);
  } };
  const sm = new InMemorySecretsManager();
  const ciphertext = kms.encrypt({ keyId: "k", plaintext: "s" }); // no context, no meta
  sm.put("u", { keyId: "k", ciphertext, encryptionContext: {} }); // empty context stored
  const broker = new KmsBrokerStore(sm, spy);
  expect((await broker.resolve("u"))?.secret).toBe("s");
  expect(seen[0]).toBeUndefined(); // {} was omitted, not forwarded as truthy
});

test("an unknown keyId cannot be decrypted (KMS rejects), so a stray blob is inert", async () => {
  const kms = new LocalKms();
  await expect(kms.decrypt({ keyId: "never-provisioned", ciphertext: new Uint8Array(40) })).rejects.toThrow(
    /unknown keyId/,
  );
});
