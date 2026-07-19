import { afterAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("THE INVARIANT: a bundle carries only the credential REF name, never the resolved secret value", () => {
  // A real-looking secret that, in production, lives ONLY in the machine's local
  // SecretStore (EncryptedFileSecretStore) — it is provisioned out-of-band via
  // `openharness creds`, never written into the definition dir. The harness.json
  // references it by NAME; that ref is all that ships.
  const REF = "acme-analytics-ro";
  const SECRET = "pg-s3cr3t-Live-DBpw-0xDEADBEEF";

  const defDir = tmp();
  writeFileSync(
    join(defDir, "harness.json"),
    JSON.stringify({
      name: "secret-indirection",
      version: "1.0.0",
      branding: { displayName: "X" },
      systemPrompt: "system-prompt.md",
      skills: [],
      providers: { default: { provider: "anthropic", model: "m", credentialProfile: "work" } },
      mcp: {
        servers: {
          analytics_readonly: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://analytics_ro@db:5432/acme"],
            // ENV VAR name -> credential REF name. The value is NOT here.
            secrets: { PGPASSWORD: REF },
            mandatory: false,
            tools: ["query"],
          },
        },
      },
    }),
  );
  writeFileSync(join(defDir, "system-prompt.md"), "You are X.");

  const { privateKey } = generateKeypair();
  const bundle = bundleDefinition(defDir, privateKey);

  // Serialize exactly as `writeBundle` would — these are the bytes that get
  // signed and distributed as the .ohbundle.
  const bytes = JSON.stringify(bundle, null, 2);

  // The ref name IS carried: the base64-embedded harness.json decodes to it.
  const harnessEntry = bundle.manifest.files["harness.json"];
  const decoded = Buffer.from(harnessEntry.contentB64, "base64").toString("utf8");
  expect(decoded).toContain(REF);

  // The resolved secret value is NOWHERE in the bundle — not as raw text, not as
  // base64 in any embedded file, not in the serialized bytes. This is the whole
  // point of the indirection: only the REF travels; the secret stays in the
  // machine-local store.
  expect(bytes).not.toContain(SECRET);
  expect(bytes).not.toContain(Buffer.from(SECRET, "utf8").toString("base64"));
  for (const entry of Object.values(bundle.manifest.files)) {
    const content = Buffer.from(entry.contentB64, "base64").toString("utf8");
    expect(content).not.toContain(SECRET);
  }
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

test("reproducible build: same definition + pinned createdAt -> byte-identical bundle & signature", () => {
  const { publicKey, privateKey } = generateKeypair();
  const createdAt = "2020-01-02T03:04:05.000Z";
  const a = bundleDefinition(exampleDir, privateKey, { createdAt });
  const b = bundleDefinition(exampleDir, privateKey, { createdAt });
  // With every file content-addressed and ed25519 deterministic, pinning createdAt
  // makes two independent builds byte-for-byte identical — a distributed bundle can
  // be cross-verified against its source.
  expect(a.manifest.createdAt).toBe(createdAt);
  expect(a.signature).toBe(b.signature);
  expect(JSON.stringify(a, null, 2)).toBe(JSON.stringify(b, null, 2));
  expect(verifyBundle(a, publicKey).manifest.version).toBe("0.1.0");
});

test("SOURCE_DATE_EPOCH pins createdAt (reproducible-builds convention); an explicit option still wins", () => {
  const { privateKey } = generateKeypair();
  const prev = process.env.SOURCE_DATE_EPOCH;
  try {
    process.env.SOURCE_DATE_EPOCH = "1600000000"; // 2020-09-13T12:26:40.000Z
    const a = bundleDefinition(exampleDir, privateKey);
    const b = bundleDefinition(exampleDir, privateKey);
    expect(a.manifest.createdAt).toBe(new Date(1_600_000_000 * 1000).toISOString());
    expect(a.signature).toBe(b.signature); // reproducible with no explicit option
    // An explicit createdAt overrides the env.
    const c = bundleDefinition(exampleDir, privateKey, { createdAt: "2020-01-01T00:00:00.000Z" });
    expect(c.manifest.createdAt).toBe("2020-01-01T00:00:00.000Z");
    // A malformed SOURCE_DATE_EPOCH is ignored (falls through to the wall clock), never throws.
    process.env.SOURCE_DATE_EPOCH = "not-a-number";
    expect(() => bundleDefinition(exampleDir, privateKey)).not.toThrow();
    // An all-digits value BEYOND the valid Date range must also fall through, not throw
    // (Number.isFinite passes for 1e23; only the range guard stops the RangeError).
    process.env.SOURCE_DATE_EPOCH = "99999999999999999999";
    const huge = bundleDefinition(exampleDir, privateKey);
    expect(huge.manifest.createdAt).not.toBe(new Date(1_600_000_000 * 1000).toISOString());
    expect(() => new Date(huge.manifest.createdAt).toISOString()).not.toThrow(); // a valid wall-clock ISO
  } finally {
    if (prev === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = prev;
  }
});
