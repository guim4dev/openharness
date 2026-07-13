import { afterAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sign as cryptoSign } from "node:crypto";
import { canonicalJSON } from "@openharness/audit";
import {
  generateKeypair,
  bundleDefinition,
  writeBundle,
  verifyBundle,
  extractBundle,
  loadVerifiedDefinition,
  BundleVerificationError,
  type Bundle,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, "..", "..", "..", "harnesses", "example");

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ohbundle-test-"));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

test("(a) keypair -> bundle harnesses/example -> verifyBundle passes with matching pubkey", () => {
  const { publicKey, privateKey } = generateKeypair();
  const bundle = bundleDefinition(exampleDir, privateKey);

  expect(bundle.manifest.name).toBe("example");
  expect(bundle.manifest.version).toBe("0.1.0");
  const files = Object.keys(bundle.manifest.files);
  expect(files).toContain("harness.json");
  expect(files).toContain("system-prompt.md");
  expect(files).toContain("skills/triage/SKILL.md");
  // deterministic sorted order
  expect(files).toEqual([...files].sort());

  const res = verifyBundle(bundle, publicKey);
  expect(res.ok).toBe(true);
  expect(res.manifest.name).toBe("example");
});

test("(b) tampering a file's contentB64 makes verifyBundle throw", () => {
  const { publicKey, privateKey } = generateKeypair();
  const bundle = bundleDefinition(exampleDir, privateKey);

  const tampered: Bundle = structuredClone(bundle);
  tampered.manifest.files["harness.json"].contentB64 = Buffer.from('{"name":"evil"}').toString("base64");

  expect(() => verifyBundle(tampered, publicKey)).toThrow(BundleVerificationError);
});

test("(b') content/sha256 mismatch is caught by the integrity gate even under a VALID signature", () => {
  // Prove step (b) is an independent gate, not dead code: re-sign a manifest whose
  // contentB64 no longer matches its recorded sha256. Signature (a) passes; (b) must fail.
  const { publicKey, privateKey } = generateKeypair();
  const good = bundleDefinition(exampleDir, privateKey);
  const manifest = structuredClone(good.manifest);
  manifest.files["harness.json"].contentB64 = Buffer.from("tampered-but-resigned").toString("base64");
  const signature = cryptoSign(null, Buffer.from(canonicalJSON(manifest), "utf8"), privateKey).toString("base64");
  const bundle: Bundle = { manifest, signature };

  // sanity: the signature really is valid over this manifest
  expect(() => verifyBundle(bundle, publicKey)).toThrow(/integrity|sha256|tampered/i);
});

test("(c) verifying with a DIFFERENT pubkey throws", () => {
  const a = generateKeypair();
  const b = generateKeypair();
  const bundle = bundleDefinition(exampleDir, a.privateKey);

  expect(() => verifyBundle(bundle, b.publicKey)).toThrow(BundleVerificationError);
});

test("(d) minVersion newer than the bundle throws (stale); equal/older passes", () => {
  const { publicKey, privateKey } = generateKeypair();
  const bundle = bundleDefinition(exampleDir, privateKey); // version 0.1.0

  expect(() => verifyBundle(bundle, publicKey, { minVersion: "0.2.0" })).toThrow(BundleVerificationError);
  expect(() => verifyBundle(bundle, publicKey, { minVersion: "1.0.0" })).toThrow(/stale|older/i);
  expect(verifyBundle(bundle, publicKey, { minVersion: "0.1.0" }).ok).toBe(true);
  expect(verifyBundle(bundle, publicKey, { minVersion: "0.0.9" }).ok).toBe(true);
});

test("(e) round-trip: bundle -> writeBundle -> loadVerifiedDefinition returns the HarnessDefinition", async () => {
  const { publicKey, privateKey } = generateKeypair();
  const bundle = bundleDefinition(exampleDir, privateKey);
  const out = join(tmp(), "example.ohbundle");
  writeBundle(bundle, out);

  const def = await loadVerifiedDefinition(out, publicKey);
  expect(def.manifest.name).toBe("example");
  expect(def.systemPromptText.length).toBeGreaterThan(0);
});

test("loadVerifiedDefinition refuses to load a bundle signed by the wrong key", async () => {
  const signer = generateKeypair();
  const attacker = generateKeypair();
  const bundle = bundleDefinition(exampleDir, signer.privateKey);
  const out = join(tmp(), "wrong-key.ohbundle");
  writeBundle(bundle, out);

  await expect(loadVerifiedDefinition(out, attacker.publicKey)).rejects.toThrow(BundleVerificationError);
});

test("extractBundle rejects path-traversal entries", () => {
  const dest = tmp();
  const evil: Bundle = {
    manifest: {
      name: "x",
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      files: { "../escape.txt": { sha256: "00", contentB64: Buffer.from("x").toString("base64") } },
    },
    signature: "",
  };
  expect(() => extractBundle(evil, dest)).toThrow(BundleVerificationError);
});
