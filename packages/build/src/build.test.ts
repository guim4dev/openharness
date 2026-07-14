import { afterAll, beforeAll, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeypair, verifyBundle } from "@openharness/bundle";
import { buildHarnessApp } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const exampleDir = join(repoRoot, "harnesses", "example");

const tmps: string[] = [];
let outDir: string;
let privateKeyPath: string;
let publicKeyPem: string;

/** Recursively list every regular file under `dir` (absolute paths). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

/**
 * Spawn the baked sidecar in verified-boot mode (pointed at the baked
 * harness.ohbundle + org.pub) and resolve with the first JSON handshake line it
 * prints. Kills the child once captured so the test never hangs.
 */
function bootAndCaptureHandshake(
  serverPath: string,
  resourcesDir: string,
): Promise<{ port: number; token: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        OH_BUNDLE_PATH: join(resourcesDir, "harness.ohbundle"),
        OH_ORG_PUBKEY_PATH: join(resourcesDir, "org.pub"),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      setTimeout(fn, 100);
    };
    const timer = setTimeout(() => {
      done(() => reject(new Error("timed out waiting for sidecar handshake")));
    }, 25000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const h = JSON.parse(t) as { port?: unknown; token?: unknown };
          if (typeof h.port === "number" && typeof h.token === "string") {
            done(() => resolvePromise({ port: h.port as number, token: h.token as string }));
            return;
          }
        } catch {
          /* non-JSON chatter; keep scanning */
        }
      }
    });
    child.on("error", (e) => done(() => reject(e)));
  });
}

beforeAll(async () => {
  const work = mkdtempSync(join(tmpdir(), "oh-build-test-"));
  tmps.push(work);
  const kp = generateKeypair();
  publicKeyPem = kp.publicKey;
  privateKeyPath = join(work, "org.key");
  writeFileSync(privateKeyPath, kp.privateKey, { mode: 0o600 });
  outDir = join(work, "out");
  await buildHarnessApp({
    defDir: exampleDir,
    privateKeyPath,
    outDir,
    org: "acme",
    name: "assistant",
  });
}, 60000);

afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

test("(a) templated tauri.conf.json: identifier + productName derive from the definition; bundle.resources lists the baked files", () => {
  const conf = JSON.parse(readFileSync(join(outDir, "src-tauri", "tauri.conf.json"), "utf8"));
  expect(conf.identifier).toBe("ai.openharness.acme.assistant");
  expect(conf.productName).toBe("Acme Assistant"); // harness.json branding.displayName
  const dests = Object.values(conf.bundle.resources as Record<string, string>);
  expect(dests).toContain("harness.ohbundle");
  expect(dests).toContain("org.pub");
  expect(dests).toContain("server.mjs");
  expect(dests).toContain("min-version.txt");
  // src keys are relative to src-tauri and resolve into ../resources/
  for (const src of Object.keys(conf.bundle.resources as Record<string, string>)) {
    expect(existsSync(resolve(outDir, "src-tauri", src))).toBe(true);
  }
});

test("(b) the baked harness.ohbundle verifyBundle-passes against the generated pubkey, and org.pub is the PUBLIC key", () => {
  const bundlePath = join(outDir, "resources", "harness.ohbundle");
  const res = verifyBundle(bundlePath, publicKeyPem);
  expect(res.ok).toBe(true);
  expect(res.manifest.name).toBe("example");

  const orgPub = readFileSync(join(outDir, "resources", "org.pub"), "utf8");
  expect(orgPub.trim()).toBe(publicKeyPem.trim());
  expect(orgPub).toContain("PUBLIC KEY");
  expect(orgPub).not.toContain("PRIVATE KEY");
});

test("(b2) ANTI-ROLLBACK: baked min-version.txt carries the definition's version as the floor", () => {
  const floor = readFileSync(join(outDir, "resources", "min-version.txt"), "utf8").trim();
  // harnesses/example is version 0.1.0 — the build bakes it as the rollback floor.
  expect(floor).toBe("0.1.0");
});

test("(c) KEY-SCAN: no private-key material anywhere under outDir", () => {
  const privatePem = readFileSync(privateKeyPath, "utf8");
  // distinctive base64 body of the private key (armor + whitespace stripped)
  const body = privatePem.replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/\s+/g, "");
  expect(body.length).toBeGreaterThan(40);

  const files = walk(outDir);
  expect(files.length).toBeGreaterThan(0);
  // sanity: the scan really covered the resources we authored
  expect(files.some((f) => f.endsWith(`${"/"}org.pub`))).toBe(true);

  for (const f of files) {
    // latin1 preserves every byte 1:1 so binary files are scanned too
    const text = readFileSync(f).toString("latin1");
    // guarded with toBe(false) (not toContain) so a hit never dumps a 14MB diff
    expect(text.includes("PRIVATE KEY"), `PRIVATE KEY marker found in ${f}`).toBe(false);
    expect(text.includes(body), `private-key body leaked into ${f}`).toBe(false);
  }
});

test("(e) FAIL-LOUD: a promptLibrary OUTSIDE the definition dir fails the build with a clear, named error", async () => {
  const work = mkdtempSync(join(tmpdir(), "oh-build-escape-"));
  tmps.push(work);

  // A VALID prompt library living OUTSIDE the definition dir: load succeeds on
  // this author's disk, so nothing fails until the build path check.
  const sharedDir = join(work, "shared");
  mkdirSync(sharedDir, { recursive: true });
  writeFileSync(
    join(sharedDir, "base.md"),
    "---\nname: base\ndescription: base prompt\n---\nBe helpful.\n",
  );

  // The definition references the outside library via '../shared'.
  const defDir = join(work, "def");
  mkdirSync(join(defDir, "skills", "triage"), { recursive: true });
  writeFileSync(join(defDir, "skills", "triage", "SKILL.md"), "# triage\n");
  writeFileSync(join(defDir, "system-prompt.md"), "You are helpful.\n");
  writeFileSync(
    join(defDir, "harness.json"),
    JSON.stringify({
      name: "escaper",
      version: "0.1.0",
      branding: { displayName: "Escaper" },
      systemPrompt: "system-prompt.md",
      promptLibrary: "../shared",
      skills: [{ path: "skills/triage", mandatory: true }],
      providers: { default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" } },
    }),
  );

  const kp = generateKeypair();
  const keyPath = join(work, "org.key");
  writeFileSync(keyPath, kp.privateKey, { mode: 0o600 });

  await expect(
    buildHarnessApp({
      defDir,
      privateKeyPath: keyPath,
      outDir: join(work, "out"),
      org: "acme",
      name: "escaper",
    }),
  ).rejects.toThrow(/promptLibrary|outside the definition|\.\.\/shared|\.\.[\\/]shared/i);

  // Fail-loud, not fail-broken: no half-built artifact was shipped.
  expect(existsSync(join(work, "out", "resources", "harness.ohbundle"))).toBe(false);
});

test("(f) an inside-dir definition passes path validation and builds (the example build in beforeAll)", () => {
  // The example harness references only inside-dir paths; its successful build
  // in beforeAll is the positive case — the signed bundle exists.
  expect(existsSync(join(outDir, "resources", "harness.ohbundle"))).toBe(true);
});

test("(d) server.mjs exists and boots to a verified handshake from the baked resources", async () => {
  const serverPath = join(outDir, "resources", "server.mjs");
  expect(existsSync(serverPath)).toBe(true);
  const handshake = await bootAndCaptureHandshake(serverPath, join(outDir, "resources"));
  expect(typeof handshake.port).toBe("number");
  expect(handshake.port).toBeGreaterThan(0);
  expect(handshake.token.length).toBeGreaterThan(0);
}, 30000);
