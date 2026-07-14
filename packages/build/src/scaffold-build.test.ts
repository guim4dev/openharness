import { afterAll, beforeAll, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, verifyBundle } from "@openharness/bundle";
import { scaffoldHarness } from "@openharness/definition";
import { buildHarnessApp } from "./index.ts";

// A freshly `openharness init`-scaffolded harness must be BUILDABLE end to end,
// entirely offline: no mcp section means no server to connect to, and the
// starter policy/skill/prompt are all self-contained inside the definition dir.

let work: string;
let defDir: string;
let outDir: string;
let privateKeyPath: string;
let publicKeyPem: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "oh-scaffold-build-"));
  const kp = generateKeypair();
  publicKeyPem = kp.publicKey;
  privateKeyPath = join(work, "org.key");
  writeFileSync(privateKeyPath, kp.privateKey, { mode: 0o600 });

  defDir = join(work, "scaffolded");
  await scaffoldHarness(defDir, { name: "scaffold-test", displayName: "Scaffold Test" });

  outDir = join(work, "out");
}, 60000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

test("buildHarnessApp on a scaffoldHarness() output yields a verifying bundle, offline", async () => {
  const result = await buildHarnessApp({
    defDir,
    privateKeyPath,
    outDir,
    org: "acme",
    name: "scaffold-test",
  });

  expect(result.identifier).toBe("ai.openharness.acme.scaffold-test");
  expect(result.productName).toBe("Scaffold Test");
  expect(result.bundle.name).toBe("scaffold-test");

  const bundlePath = join(outDir, "resources", "harness.ohbundle");
  expect(existsSync(bundlePath)).toBe(true);
  const verified = verifyBundle(bundlePath, publicKeyPem);
  expect(verified.ok).toBe(true);
  expect(verified.manifest.name).toBe("scaffold-test");

  const orgPub = readFileSync(join(outDir, "resources", "org.pub"), "utf8");
  expect(orgPub).toContain("PUBLIC KEY");
  expect(orgPub).not.toContain("PRIVATE KEY");
}, 60000);
