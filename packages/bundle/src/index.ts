import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { canonicalJSON } from "@openharness/audit";
import { loadHarnessDefinition } from "@openharness/definition";
import type { HarnessDefinition } from "@openharness/definition";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One file inside a bundle: its content (base64) plus a sha256 (hex) of the raw bytes. */
export interface BundleFileEntry {
  sha256: string;
  contentB64: string;
}

/**
 * The signed part of a bundle. `files` keys are POSIX-relative paths within the
 * definition dir (deterministic sorted order), so the canonical JSON — and thus
 * the signature — is identical on every platform.
 */
export interface BundleManifest {
  name: string;
  version: string;
  createdAt: string;
  files: Record<string, BundleFileEntry>;
}

/** A signed JSON bundle: the manifest plus an ed25519 signature (base64) over its canonical JSON. */
export interface Bundle {
  manifest: BundleManifest;
  signature: string;
}

export interface VerifyBundleOptions {
  /** Refuse the bundle if `manifest.version` is older than this (semver compare). */
  minVersion?: string;
}

export interface VerifyBundleResult {
  ok: true;
  manifest: BundleManifest;
}

/** Thrown by verifyBundle / loadVerifiedDefinition when a bundle cannot be fully trusted. */
export class BundleVerificationError extends Error {}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Generate an ed25519 keypair as PEM strings (SPKI public, PKCS#8 private).
 * Real asymmetric crypto — no stubs.
 */
export function generateKeypair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** ed25519 sign the canonical JSON of a manifest; returns a base64 signature. */
function signManifest(manifest: BundleManifest, privateKeyPem: string): string {
  const data = Buffer.from(canonicalJSON(manifest), "utf8");
  return cryptoSign(null, data, privateKeyPem).toString("base64");
}

/** All files under `root`, deterministic sorted POSIX-relative paths; skips .DS_Store. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".DS_Store") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) rec(full);
      else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  rec(root);
  return out.sort();
}

function parseVersion(v: string): number[] {
  const core = v.trim().replace(/^v/, "").split("+")[0].split("-")[0];
  return core.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

/** true when semver `a` is strictly older than `b` (major.minor.patch, pre-release ignored). */
export function isOlder(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

function readBundle(path: string): Bundle {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new BundleVerificationError(`bundle is not valid JSON: ${(e as Error).message}`);
  }
  const b = raw as Partial<Bundle>;
  if (!b || typeof b.signature !== "string" || !b.manifest || typeof b.manifest !== "object")
    throw new BundleVerificationError("bundle is missing a manifest or signature");
  return b as Bundle;
}

// ---------------------------------------------------------------------------
// Bundle / verify / extract
// ---------------------------------------------------------------------------

/**
 * Build a signed bundle from a definition directory. Walks every file under
 * `defDir`, records each one's sha256 + base64 content, reads name/version from
 * harness.json, and signs the canonical JSON of the manifest with `privateKeyPem`.
 */
export function bundleDefinition(defDir: string, privateKeyPem: string): Bundle {
  const root = resolve(defDir);
  const harnessJsonPath = join(root, "harness.json");
  if (!existsSync(harnessJsonPath))
    throw new Error(`No harness.json found in ${root} — not a definition directory`);

  let meta: { name?: unknown; version?: unknown };
  try {
    meta = JSON.parse(readFileSync(harnessJsonPath, "utf8"));
  } catch (e) {
    throw new Error(`harness.json is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof meta.name !== "string" || typeof meta.version !== "string")
    throw new Error("harness.json must define string `name` and `version`");

  const files: Record<string, BundleFileEntry> = {};
  for (const rel of walkFiles(root)) {
    const bytes = readFileSync(join(root, rel));
    files[rel] = { sha256: sha256Hex(bytes), contentB64: bytes.toString("base64") };
  }

  const manifest: BundleManifest = {
    name: meta.name,
    version: meta.version,
    createdAt: new Date().toISOString(),
    files,
  };

  return { manifest, signature: signManifest(manifest, privateKeyPem) };
}

/** JSON-serialize a bundle to `outPath` (conventionally a `.ohbundle` file). */
export function writeBundle(bundle: Bundle, outPath: string): void {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, JSON.stringify(bundle, null, 2));
}

/**
 * Verify a bundle, all-or-nothing (never partially trust):
 *  (a) the ed25519 signature over canonicalJSON(manifest) must validate under `publicKeyPem`;
 *  (b) every file's sha256 must match a fresh hash of its own contentB64;
 *  (c) if `opts.minVersion` is set, the bundle version must not be older than it.
 * Returns `{ ok: true, manifest }` or throws BundleVerificationError.
 */
export function verifyBundle(
  bundle: Bundle | string,
  publicKeyPem: string,
  opts: VerifyBundleOptions = {},
): VerifyBundleResult {
  const b = typeof bundle === "string" ? readBundle(bundle) : bundle;
  const { manifest, signature } = b;

  // (a) signature
  let sigOk = false;
  try {
    sigOk = cryptoVerify(
      null,
      Buffer.from(canonicalJSON(manifest), "utf8"),
      publicKeyPem,
      Buffer.from(signature, "base64"),
    );
  } catch (e) {
    throw new BundleVerificationError(`signature could not be verified: ${(e as Error).message}`);
  }
  if (!sigOk)
    throw new BundleVerificationError(
      "signature verification failed — bundle is unsigned, tampered, or signed by a different key",
    );

  // (b) per-file content integrity
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const actual = sha256Hex(Buffer.from(entry.contentB64, "base64"));
    if (actual !== entry.sha256)
      throw new BundleVerificationError(`file integrity check failed for '${rel}' (sha256 mismatch — tampered content)`);
  }

  // (c) staleness
  if (opts.minVersion && isOlder(manifest.version, opts.minVersion))
    throw new BundleVerificationError(
      `bundle version ${manifest.version} is older than required minimum ${opts.minVersion} (refusing stale config)`,
    );

  return { ok: true, manifest };
}

/**
 * Write a bundle's files back to `destDir`. Assumes the bundle is already verified.
 * Rejects any entry whose path escapes `destDir` (path-traversal defense).
 */
export function extractBundle(bundle: Bundle, destDir: string): void {
  const base = resolve(destDir);
  mkdirSync(base, { recursive: true });
  for (const [rel, entry] of Object.entries(bundle.manifest.files)) {
    const target = resolve(base, rel);
    if (target !== base && !target.startsWith(base + sep))
      throw new BundleVerificationError(`refusing to extract '${rel}': path escapes destination directory`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(entry.contentB64, "base64"));
  }
}

/**
 * The client trust path — "only approved config runs": verify a bundle against
 * `publicKeyPem`, extract it to a fresh temp dir, and load the resolved
 * HarnessDefinition. Throws before any extraction if verification fails.
 */
export async function loadVerifiedDefinition(
  bundlePath: string,
  publicKeyPem: string,
  opts: VerifyBundleOptions = {},
): Promise<HarnessDefinition> {
  const b = readBundle(bundlePath);
  verifyBundle(b, publicKeyPem, opts);
  const dir = mkdtempSync(join(tmpdir(), "ohbundle-"));
  extractBundle(b, dir);
  return loadHarnessDefinition(dir);
}
