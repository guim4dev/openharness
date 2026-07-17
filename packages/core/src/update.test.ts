import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { bundleDefinition, generateKeypair, writeBundle, type Bundle } from "@openharness/bundle";
import { createOpenHarnessServer, type StartedOpenHarnessServer } from "@openharness/server";
import { readFloor, refreshPinnedDefinition, resolvePinnedBundle } from "./update.ts";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const exampleHarness = join(repoRoot, "harnesses", "example"); // version 0.1.0

let running: StartedOpenHarnessServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

const KEYS = generateKeypair();
const OTHER = generateKeypair();

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "oh-update-"));
}

/**
 * Sign a REAL bundle at a chosen version. bundleDefinition reads the version
 * from disk, so we copy the example harness and rewrite harness.json's version.
 */
function signAtVersion(base: string, version: string, keys = KEYS): Bundle {
  const copy = join(base, `harness-${version}-${Math.abs(hash(version + keys.publicKey))}`);
  cpSync(exampleHarness, copy, { recursive: true });
  const hp = join(copy, "harness.json");
  const manifest = JSON.parse(readFileSync(hp, "utf8")) as { version: string };
  manifest.version = version;
  writeFileSync(hp, JSON.stringify(manifest, null, 2));
  return bundleDefinition(copy, keys.privateKey);
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const fetchReturning = (b: Bundle) => async () => b;

test("readFloor falls back when no floor file exists, then reads the persisted value", () => {
  const dir = tmp();
  const fp = join(dir, "floor.txt");
  expect(readFloor(fp, "0.1.0")).toBe("0.1.0");
  writeFileSync(fp, "0.3.0\n");
  expect(readFloor(fp)).toBe("0.3.0");
});

test("a hosted bundle NEWER than the floor is accepted, written, and advances the floor", async () => {
  const dir = tmp();
  const updatesDir = join(dir, "updates");
  const floorPath = join(dir, "floor.txt");
  const r = await refreshPinnedDefinition({
    serverUrl: "http://unused",
    pubkeyPem: KEYS.publicKey,
    updatesDir,
    floorPath,
    currentVersion: "0.1.0",
    fetchImpl: fetchReturning(signAtVersion(dir, "0.2.0")),
  });
  expect(r.updated).toBe(true);
  expect(r.version).toBe("0.2.0");
  expect(readdirSync(updatesDir)).toContain("example-0.2.0.ohbundle");
  expect(readFloor(floorPath)).toBe("0.2.0");
});

test("a rollback (older than floor) is REJECTED and the floor is not lowered", async () => {
  const dir = tmp();
  const floorPath = join(dir, "floor.txt");
  writeFileSync(floorPath, "0.2.0\n");
  const r = await refreshPinnedDefinition({
    serverUrl: "http://unused",
    pubkeyPem: KEYS.publicKey,
    updatesDir: join(dir, "updates"),
    floorPath,
    fetchImpl: fetchReturning(signAtVersion(dir, "0.1.0")),
  });
  expect(r.updated).toBe(false);
  expect(r.rejected).toBe(true);
  expect(readFloor(floorPath)).toBe("0.2.0");
});

test("a bundle signed by a DIFFERENT key is rejected (not org-signed)", async () => {
  const dir = tmp();
  const r = await refreshPinnedDefinition({
    serverUrl: "http://unused",
    pubkeyPem: KEYS.publicKey,
    updatesDir: join(dir, "updates"),
    floorPath: join(dir, "floor.txt"),
    currentVersion: "0.1.0",
    fetchImpl: fetchReturning(signAtVersion(dir, "0.5.0", OTHER)),
  });
  expect(r.rejected).toBe(true);
  expect(r.updated).toBe(false);
});

test("an equal-version re-fetch is a benign no-op (verified, not newer)", async () => {
  const dir = tmp();
  const r = await refreshPinnedDefinition({
    serverUrl: "http://unused",
    pubkeyPem: KEYS.publicKey,
    updatesDir: join(dir, "updates"),
    floorPath: join(dir, "floor.txt"),
    currentVersion: "0.1.0",
    fetchImpl: fetchReturning(signAtVersion(dir, "0.1.0")),
  });
  expect(r.updated).toBe(false);
  expect(r.rejected).toBeFalsy();
  expect(r.reason).toMatch(/up to date/);
});

test("resolvePinnedBundle prefers a newer verified update and IGNORES a rollback bundle in the updates dir", async () => {
  const dir = tmp();
  const updatesDir = join(dir, "updates");
  const floorPath = join(dir, "floor.txt");
  const baked = join(dir, "baked.ohbundle");
  mkdirSync(updatesDir, { recursive: true });
  writeBundle(signAtVersion(dir, "0.1.0"), baked);
  writeBundle(signAtVersion(dir, "0.3.0"), join(updatesDir, "example-0.3.0.ohbundle"));
  writeBundle(signAtVersion(dir, "0.0.5"), join(updatesDir, "example-0.0.5.ohbundle")); // rollback
  writeFileSync(floorPath, "0.1.0\n");

  const picked = resolvePinnedBundle({ bakedBundlePath: baked, updatesDir, pubkeyPem: KEYS.publicKey, floorPath });
  expect(picked.version).toBe("0.3.0"); // newest verified; the 0.0.5 rollback is below floor -> ignored

  // Raise the floor above every candidate: nothing verifies -> resolve throws.
  writeFileSync(floorPath, "0.4.0\n");
  expect(() => resolvePinnedBundle({ bakedBundlePath: baked, updatesDir, pubkeyPem: KEYS.publicKey, floorPath })).toThrow();
});

test("e2e: refresh pulls a newer bundle over the REAL loopback server and pins it", async () => {
  const dir = tmp();
  const bundlesDir = join(dir, "server-bundles");
  mkdirSync(bundlesDir, { recursive: true });
  writeBundle(signAtVersion(dir, "0.2.0"), join(bundlesDir, "example.ohbundle"));
  running = await createOpenHarnessServer({ bundlesDir, auditDir: join(dir, "audit") }).start();

  const r = await refreshPinnedDefinition({
    serverUrl: running.url,
    pubkeyPem: KEYS.publicKey,
    updatesDir: join(dir, "updates"),
    floorPath: join(dir, "floor.txt"),
    currentVersion: "0.1.0",
  });
  expect(r.updated).toBe(true);
  expect(r.version).toBe("0.2.0");
});
