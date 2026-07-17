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
 * The floor is monotonic and persisted, so an attacker who later drops an older
 * (but still org-signed) bundle into the updates dir cannot roll the app back —
 * `resolvePinnedBundle` re-verifies every candidate against the same floor at
 * boot and picks the newest that survives, else the baked-in bundle.
 *
 * This is the DEFINITION-bundle channel only; app-binary auto-update (the Tauri
 * updater + OS signing) is a separate, later concern.
 */

function readBundleFile(path: string): Bundle {
  return JSON.parse(readFileSync(path, "utf8")) as Bundle;
}

/** The persisted floor, or `fallback` when no floor file exists yet. */
export function readFloor(floorPath: string, fallback = "0.0.0"): string {
  if (!existsSync(floorPath)) return fallback;
  const v = readFileSync(floorPath, "utf8").trim();
  return v.length > 0 ? v : fallback;
}

/** Advance the floor to `version` (only ever forward — a lower value is ignored). */
function bumpFloor(floorPath: string, version: string): void {
  const current = readFloor(floorPath, "0.0.0");
  if (isOlder(current, version)) writeFileSync(floorPath, `${version}\n`);
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
  const floor = readFloor(opts.floorPath, opts.currentVersion ?? "0.0.0");
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
  const tmp = `${dest}.tmp`;
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
 * Pick the bundle the app should boot: the newest bundle (baked-in or a pulled
 * update) that verifies under the org key with the persisted floor as
 * `minVersion`. A rollback bundle sitting in the updates dir is refused by the
 * floor and skipped; if nothing beats the baked bundle, the baked bundle wins.
 */
export function resolvePinnedBundle(opts: ResolveOptions): { path: string; version: string } {
  const floor = readFloor(opts.floorPath, "0.0.0");
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
