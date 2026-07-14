import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeypair, verifyBundle } from "@openharness/bundle";
import { buildHarnessApp } from "./index.ts";

// Mirrors build.test.ts, but exercises the three realistic example harnesses
// (harnesses/acme-fintech, harnesses/northwind-ops, harnesses/meridian-support)
// instead of harnesses/example — each must brand into its own
// identifier/productName and produce a bundle that verifies, entirely offline
// (no MCP server ever connects at build time).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const examples = [
  {
    defDir: join(repoRoot, "harnesses", "acme-fintech"),
    org: "acme",
    name: "engineer",
    expectedIdentifier: "ai.openharness.acme.engineer",
    expectedProductName: "Acme Engineer",
    expectedBundleName: "acme-fintech",
  },
  {
    defDir: join(repoRoot, "harnesses", "northwind-ops"),
    org: "northwind",
    name: "ops",
    expectedIdentifier: "ai.openharness.northwind.ops",
    expectedProductName: "Northwind Ops Copilot",
    expectedBundleName: "northwind-ops",
  },
  {
    defDir: join(repoRoot, "harnesses", "meridian-support"),
    org: "meridian",
    name: "support",
    expectedIdentifier: "ai.openharness.meridian.support",
    expectedProductName: "Meridian Support Desk",
    expectedBundleName: "meridian-support",
  },
] as const;

const tmps: string[] = [];
let privateKeyPath: string;
let publicKeyPem: string;

beforeAll(() => {
  const work = mkdtempSync(join(tmpdir(), "oh-examples-build-"));
  tmps.push(work);
  const kp = generateKeypair();
  publicKeyPem = kp.publicKey;
  privateKeyPath = join(work, "org.key");
  writeFileSync(privateKeyPath, kp.privateKey, { mode: 0o600 });
});

afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// Populated by the per-example test below; checked for cross-brand collision
// afterward without paying for a third build.
const built: { identifier: string; productName: string }[] = [];

for (const ex of examples) {
  test(`buildHarnessApp(${ex.expectedBundleName}) brands a distinct project and yields a verifying bundle, offline`, async () => {
    const work = mkdtempSync(join(tmpdir(), `oh-examples-build-${ex.expectedBundleName}-`));
    tmps.push(work);
    const outDir = join(work, "out");

    const result = await buildHarnessApp({
      defDir: ex.defDir,
      privateKeyPath,
      outDir,
      org: ex.org,
      name: ex.name,
    });
    built.push({ identifier: result.identifier, productName: result.productName });

    expect(result.identifier).toBe(ex.expectedIdentifier);
    expect(result.productName).toBe(ex.expectedProductName);
    expect(result.bundle.name).toBe(ex.expectedBundleName);

    const conf = JSON.parse(readFileSync(join(outDir, "src-tauri", "tauri.conf.json"), "utf8"));
    expect(conf.identifier).toBe(ex.expectedIdentifier);
    expect(conf.productName).toBe(ex.expectedProductName);

    const bundlePath = join(outDir, "resources", "harness.ohbundle");
    const verified = verifyBundle(bundlePath, publicKeyPem);
    expect(verified.ok).toBe(true);
    expect(verified.manifest.name).toBe(ex.expectedBundleName);

    const orgPub = readFileSync(join(outDir, "resources", "org.pub"), "utf8");
    expect(orgPub).toContain("PUBLIC KEY");
    expect(orgPub).not.toContain("PRIVATE KEY");
  }, 60000);
}

test("the three builds get distinct identifiers and product names (no cross-brand collision)", () => {
  expect(built).toHaveLength(examples.length);
  const identifiers = new Set(built.map((b) => b.identifier));
  const productNames = new Set(built.map((b) => b.productName));
  expect(identifiers.size).toBe(examples.length);
  expect(productNames.size).toBe(examples.length);
});
