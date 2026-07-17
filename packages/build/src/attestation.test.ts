import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import {
  sha256Hex,
  signProvenance,
  verifyProvenance,
  type InTotoStatement,
  type TrustRoot,
} from "./attestation.ts";

function keypair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const ARTIFACT_BYTES = Buffer.from("the built harness bundle bytes");
const DIGEST = sha256Hex(ARTIFACT_BYTES);
const NAME = "pkg:npm/%40earendil-works/pi-coding-agent@0.80.6";
const BUILDER = "https://github.com/openharness/openharness/.github/workflows/release.yml@refs/tags/v0.80.6";

function statement(overrides: Partial<InTotoStatement> = {}): InTotoStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: NAME, digest: { sha256: DIGEST } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: { runDetails: { builder: { id: BUILDER } } },
    ...overrides,
  };
}

test("a genuine, correctly-signed provenance verifies", () => {
  const { publicKey, privateKey } = keypair();
  const env = signProvenance(statement(), privateKey);
  const trust: TrustRoot = { keys: [publicKey], allowedBuilders: [BUILDER] };
  const v = verifyProvenance({ name: NAME, sha256: DIGEST }, env, trust);
  expect(v.verified).toBe(true);
  expect(v.builderId).toBe(BUILDER);
});

test("a provenance signed by an UNTRUSTED key is rejected (forged attestation)", () => {
  const signer = keypair();
  const stranger = keypair();
  const env = signProvenance(statement(), signer.privateKey);
  const v = verifyProvenance({ name: NAME, sha256: DIGEST }, env, { keys: [stranger.publicKey], allowedBuilders: [BUILDER] });
  expect(v.verified).toBe(false);
  expect(v.reason).toMatch(/no trusted key/);
});

test("a digest MISMATCH is rejected — a swapped artifact under a real attestation fails", () => {
  const { publicKey, privateKey } = keypair();
  const env = signProvenance(statement(), privateKey);
  const trust: TrustRoot = { keys: [publicKey], allowedBuilders: [BUILDER] };
  const v = verifyProvenance({ name: NAME, sha256: sha256Hex(Buffer.from("a DIFFERENT artifact")) }, env, trust);
  expect(v.verified).toBe(false);
  expect(v.reason).toMatch(/digest does not match/);
});

test("a tampered payload breaks the signature (envelope not malleable)", () => {
  const { publicKey, privateKey } = keypair();
  const env = signProvenance(statement(), privateKey);
  // Re-encode a payload with a different builder but keep the original signature.
  env.payload = Buffer.from(
    JSON.stringify(statement({ predicate: { runDetails: { builder: { id: "https://evil.example/builder" } } } })),
  ).toString("base64");
  const v = verifyProvenance({ name: NAME, sha256: DIGEST }, env, { keys: [publicKey], allowedBuilders: [BUILDER] });
  expect(v.verified).toBe(false);
  expect(v.reason).toMatch(/no trusted key/);
});

test("a trusted key but a builder NOT on the allowlist is rejected (leaked-key defense)", () => {
  const { publicKey, privateKey } = keypair();
  const env = signProvenance(statement({ predicate: { runDetails: { builder: { id: "https://random-ci/builder" } } } }), privateKey);
  const v = verifyProvenance({ name: NAME, sha256: DIGEST }, env, { keys: [publicKey], allowedBuilders: [BUILDER] });
  expect(v.verified).toBe(false);
  expect(v.reason).toMatch(/not an allowed builder/);
});

test("a statement without our subject name is rejected (attestation for another artifact)", () => {
  const { publicKey, privateKey } = keypair();
  const env = signProvenance(statement({ subject: [{ name: "pkg:npm/other@1.0.0", digest: { sha256: DIGEST } }] }), privateKey);
  const v = verifyProvenance({ name: NAME, sha256: DIGEST }, env, { keys: [publicKey], allowedBuilders: [BUILDER] });
  expect(v.verified).toBe(false);
  expect(v.reason).toMatch(/no subject named/);
});
