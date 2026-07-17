import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBundle } from "@openharness/server";
import { BundleVerificationError, isOlder, verifyBundle, writeBundle, type Bundle } from "@openharness/bundle";

/**
 * Signed-definition update channel with a persisted anti-rollback FLOOR.
 *
 * The control plane distributes definitions; this is the pull side. A refresh
 * fetches the hosted bundle, verifies it under the org public key with the floor
 * as `minVersion` (so a tampered OR older-than-floor bundle is refused), and only
 * an accepted NEWER bundle is written to the updates dir and advances the floor.
 * The floor is monotonic and persisted. Its DURABLE guarantee is anchored to the
 * BAKED bundle (shipped inside the signed app): `resolvePinnedBundle` never boots
 * anything older than the baked version — even with no/deleted/corrupt floor file.
 * The persisted floor RAISES that bar as updates advance, but it lives in the same
 * user-writable dir as the updates, so an attacker who can write there can also
 * delete it, rolling the durable floor down to (never below) the baked version.
 * `resolvePinnedBundle` re-verifies every candidate against the effective floor at
 * boot and picks the newest that survives, else the baked-in bundle. (Making the
 * floor tamper-proof against a same-dir writer — a sealed/keychain-backed floor —
 * is a separate hardening.)
 *
 * This is the DEFINITION-bundle channel only; app-binary auto-update (the Tauri
 * updater + OS signing) is a separate, later concern.
 */

function readBundleFile(path: string): Bundle {
  return JSON.parse(readFileSync(path, "utf8")) as Bundle;
}

let tmpSeq = 0;
/** A monotonic per-process suffix so concurrent temp writes never collide. */
function nextTmpSeq(): number {
  return tmpSeq++;
}

/** A concrete semver-ish version: digits.digits[.digits][-prerelease][+build]. */
const VERSION_RE = /^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * The persisted floor, or `fallback` when it is absent OR unparseable. Fails
 * CLOSED to the caller's trustworthy lower bound: a garbage/torn/hostile floor
 * file must NEVER read as `0.0.0` (the lowest possible floor), which would let a
 * rollback through — the exact write access the floor is meant to defend against
 * could otherwise disable it by corrupting the file.
 */
export function readFloor(floorPath: string, fallback = "0.0.0"): string {
  if (!existsSync(floorPath)) return fallback;
  let v: string;
  try {
    v = readFileSync(floorPath, "utf8").trim();
  } catch {
    return fallback;
  }
  return VERSION_RE.test(v) ? v : fallback;
}

/** The larger of two versions (the anti-rollback lower bound never drops). */
function maxVersion(a: string, b: string): string {
  return isOlder(a, b) ? b : a;
}

/** Atomically advance the floor to `version` (only ever forward). */
function bumpFloor(floorPath: string, version: string): void {
  const current = readFloor(floorPath, "0.0.0");
  if (isOlder(current, version)) {
    const tmp = `${floorPath}.tmp`;
    writeFileSync(tmp, `${version}\n`);
    renameSync(tmp, floorPath); // atomic: a torn write never leaves a garbage floor
  }
}

export interface RefreshOptions {
  serverUrl: string;
  /** Org public key (PEM) the bundle signature must validate under. */
  pubkeyPem: string;
  /** Directory accepted updates are written into (created on demand). */
  updatesDir: string;
  /** File holding the monotonic version floor. */
  floorPath: string;
  /** Bundle name to fetch (server may host several). */
  name?: string;
  token?: string;
  /** The baked-in bundle's version — the initial floor when no floor file exists. */
  currentVersion?: string;
  /** Test seam: override the fetch (defaults to the HTTP `fetchBundle`). */
  fetchImpl?: (serverUrl: string, token?: string, name?: string) => Promise<Bundle>;
}

export interface RefreshResult {
  /** True when a strictly-newer, verified bundle was accepted + written. */
  updated: boolean;
  /** The pinned version after this refresh (accepted version, else the floor). */
  version: string;
  /** True when the hosted bundle FAILED verification (tamper / rollback) — a security event. */
  rejected?: boolean;
  reason?: string;
}

export async function refreshPinnedDefinition(opts: RefreshOptions): Promise<RefreshResult> {
  // Effective floor = max(persisted floor, currentVersion). currentVersion is the
  // running app's baked version — a trustworthy lower bound the floor file can
  // only RAISE, never lower. So a deleted/corrupt/lowered floor still can't
  // accept a rollback below what's already installed.
  const persisted = readFloor(opts.floorPath, opts.currentVersion ?? "0.0.0");
  const floor = opts.currentVersion ? maxVersion(persisted, opts.currentVersion) : persisted;
  const fetchImpl = opts.fetchImpl ?? fetchBundle;
  const bundle = await fetchImpl(opts.serverUrl, opts.token, opts.name);

  let manifest;
  try {
    // Floor as minVersion: a tampered signature, a failed file hash, or a
    // version OLDER than the floor all throw here (fail-closed).
    ({ manifest } = verifyBundle(bundle, opts.pubkeyPem, { minVersion: floor }));
  } catch (e) {
    if (e instanceof BundleVerificationError) return { updated: false, version: floor, rejected: true, reason: e.message };
    throw e;
  }

  // Verified — but accept as an UPDATE only if strictly newer than the floor
  // (an equal-version re-fetch is a benign no-op).
  if (!isOlder(floor, manifest.version)) {
    return { updated: false, version: floor, reason: "already up to date" };
  }

  mkdirSync(opts.updatesDir, { recursive: true });
  const dest = join(opts.updatesDir, `${manifest.name}-${manifest.version}.ohbundle`);
  // Per-invocation temp name so two concurrent refreshes never write the same
  // temp file and rename an interleaved (corrupt) blob into place.
  const tmp = `${dest}.${process.pid}.${nextTmpSeq()}.tmp`;
  writeBundle(bundle, tmp);
  renameSync(tmp, dest); // atomic: a partial download is never a boot candidate
  bumpFloor(opts.floorPath, manifest.version);
  return { updated: true, version: manifest.version };
}

export interface ResolveOptions {
  /** The baked-in signed bundle shipped with the app. */
  bakedBundlePath: string;
  updatesDir: string;
  pubkeyPem: string;
  floorPath: string;
}

/**
 * Pick the bundle the app should boot: the newest that verifies under the org
 * key at the effective floor. The effective floor is max(persisted floor, the
 * baked bundle's version) — the baked bundle is shipped INSIDE the signed app,
 * so its version is a trustworthy lower bound the local floor file can only
 * RAISE. That closes the rollback-via-deleted/corrupt-floor hole: even with no
 * floor file, nothing OLDER than the baked bundle is ever booted. A rollback or
 * tampered bundle in the updates dir is refused and skipped; ties go to baked.
 */
export function resolvePinnedBundle(opts: ResolveOptions): { path: string; version: string } {
  // The baked bundle's own version is the trustworthy lower bound. Verify it
  // WITHOUT a floor to read its version. If the baked bundle is PRESENT but does
  // not verify under the org key, that is a hard integrity failure — refuse to
  // boot. Silently dropping the anchor here (to the attacker-writable floor file
  // or 0.0.0) would let a tampered/unreadable baked bundle COLLAPSE the
  // anti-rollback floor, so an older org-signed bundle in the updates dir would
  // boot. Only a genuinely ABSENT baked bundle falls back to the persisted floor.
  let bakedVersion: string | undefined;
  if (existsSync(opts.bakedBundlePath)) {
    try {
      bakedVersion = verifyBundle(readBundleFile(opts.bakedBundlePath), opts.pubkeyPem, {}).manifest.version;
    } catch {
      throw new BundleVerificationError(
        `baked bundle is present but does not verify under the org key — refusing to boot (a tampered baked bundle must not collapse the anti-rollback floor): ${opts.bakedBundlePath}`,
      );
    }
  }
  const persisted = readFloor(opts.floorPath, bakedVersion ?? "0.0.0");
  const floor = bakedVersion ? maxVersion(persisted, bakedVersion) : persisted;

  const candidates: string[] = [opts.bakedBundlePath];
  if (existsSync(opts.updatesDir)) {
    for (const f of readdirSync(opts.updatesDir)) {
      if (f.endsWith(".ohbundle")) candidates.push(join(opts.updatesDir, f));
    }
  }

  let best: { path: string; version: string } | undefined;
  for (const path of candidates) {
    let bundle: Bundle;
    try {
      bundle = readBundleFile(path);
    } catch {
      continue; // unreadable / partial — skip
    }
    try {
      const { manifest } = verifyBundle(bundle, opts.pubkeyPem, { minVersion: floor });
      if (!best || isOlder(best.version, manifest.version)) best = { path, version: manifest.version };
    } catch {
      continue; // tampered / rolled-back / below floor — never a boot candidate
    }
  }

  if (!best) throw new BundleVerificationError("no bundle verifies under the org key at the current floor");
  return best;
}
