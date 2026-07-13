import { afterAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  BundleVerificationError,
  bundleDefinition,
  generateKeypair,
  verifyBundle,
  writeBundle,
  type Bundle,
} from "@openharness/bundle";
import { createOpenHarnessServer, fetchBundle, pushAudit } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, "..", "..", "..", "harnesses", "example");

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ohserver-test-"));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

test("(a) GET /health is 200 without a token, even when a token is configured", async () => {
  const server = createOpenHarnessServer({
    bundlesDir: tmp(),
    auditDir: tmp(),
    token: "configured-but-irrelevant-here",
  });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  } finally {
    await close();
  }
});

test("(b) with a token set, GET /bundle and POST /audit are 401 without the bearer header, 200 with it", async () => {
  const bundlesDir = tmp();
  const { privateKey } = generateKeypair();
  const bundle = bundleDefinition(exampleDir, privateKey);
  writeBundle(bundle, join(bundlesDir, "example.ohbundle"));

  const token = "s3kr3t-token";
  const server = createOpenHarnessServer({ bundlesDir, auditDir: tmp(), token });
  const { url, close } = await server.start();
  try {
    const noAuthBundle = await fetch(`${url}/bundle`);
    expect(noAuthBundle.status).toBe(401);
    expect(await noAuthBundle.json()).toEqual({ error: "unauthorized" });

    const noAuthAudit = await fetch(`${url}/audit`, { method: "POST", body: '{"a":1}\n' });
    expect(noAuthAudit.status).toBe(401);
    expect(await noAuthAudit.json()).toEqual({ error: "unauthorized" });

    const withAuthBundle = await fetch(`${url}/bundle`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withAuthBundle.status).toBe(200);

    const withAuthAudit = await fetch(`${url}/audit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: '{"a":1}\n',
    });
    expect(withAuthAudit.status).toBe(200);
    expect(await withAuthAudit.json()).toEqual({ ingested: 1 });
  } finally {
    await close();
  }
});

test("(c) GET /bundle returns the newest .ohbundle with x-oh-version header; 404 when none exist", async () => {
  const bundlesDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir, auditDir: tmp() });
  const { url, close } = await server.start();
  try {
    const empty = await fetch(`${url}/bundle`);
    expect(empty.status).toBe(404);

    const { privateKey } = generateKeypair();
    const bundle = bundleDefinition(exampleDir, privateKey); // version 0.1.0
    writeBundle(bundle, join(bundlesDir, "example.ohbundle"));

    const res = await fetch(`${url}/bundle`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-oh-version")).toBe("0.1.0");
    const body = (await res.json()) as Bundle;
    expect(body.manifest.name).toBe("example");
    expect(body.signature).toBe(bundle.signature);
  } finally {
    await close();
  }
});

test("(c') GET /bundle?name=X selects the matching bundle; unknown name -> 404", async () => {
  const bundlesDir = tmp();
  const { privateKey } = generateKeypair();
  const bundle = bundleDefinition(exampleDir, privateKey);
  writeBundle(bundle, join(bundlesDir, "example.ohbundle"));

  const server = createOpenHarnessServer({ bundlesDir, auditDir: tmp() });
  const { url, close } = await server.start();
  try {
    const match = await fetch(`${url}/bundle?name=example`);
    expect(match.status).toBe(200);

    const noMatch = await fetch(`${url}/bundle?name=nonexistent`);
    expect(noMatch.status).toBe(404);
  } finally {
    await close();
  }
});

test("(d) POST /audit with 2 NDJSON lines appends both, verbatim, to ingested-<date>.jsonl", async () => {
  const auditDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const { url, close } = await server.start();
  try {
    const lines = ['{"seq":0,"v":1}', '{"seq":1,"v":1}'];
    const res = await fetch(`${url}/audit`, { method: "POST", body: lines.join("\n") + "\n" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2 });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(auditDir, `ingested-${today}.jsonl`);
    expect(existsSync(filePath)).toBe(true);
    const written = readFileSync(filePath, "utf8").trim().split("\n");
    expect(written).toEqual(lines);

    // a second POST appends rather than overwrites
    const res2 = await fetch(`${url}/audit`, { method: "POST", body: '{"seq":2,"v":1}\n' });
    expect(await res2.json()).toEqual({ ingested: 1 });
    const written2 = readFileSync(filePath, "utf8").trim().split("\n");
    expect(written2).toEqual([...lines, '{"seq":2,"v":1}']);
  } finally {
    await close();
  }
});

test("(e) client round-trip: fetchBundle -> verifyBundle passes with matching pubkey, throws with the wrong key", async () => {
  const bundlesDir = tmp();
  const { publicKey, privateKey } = generateKeypair();
  const wrong = generateKeypair();
  const bundle = bundleDefinition(exampleDir, privateKey);
  writeBundle(bundle, join(bundlesDir, "example.ohbundle"));

  const token = "roundtrip-token";
  const server = createOpenHarnessServer({ bundlesDir, auditDir: tmp(), token });
  const { url, close } = await server.start();
  try {
    const fetched = await fetchBundle(url, token);
    const result = verifyBundle(fetched, publicKey);
    expect(result.ok).toBe(true);
    expect(result.manifest.name).toBe("example");

    expect(() => verifyBundle(fetched, wrong.publicKey)).toThrow(BundleVerificationError);

    await expect(fetchBundle(url)).rejects.toThrow(/401|unauthorized/i);
  } finally {
    await close();
  }
});

test("pushAudit client helper round-trips through POST /audit", async () => {
  const auditDir = tmp();
  const token = "push-token";
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir, token });
  const { url, close } = await server.start();
  try {
    const result = await pushAudit(url, token, ['{"x":1}', '{"x":2}']);
    expect(result.ingested).toBe(2);

    await expect(pushAudit(url, undefined, ['{"x":3}'])).rejects.toThrow(/401|unauthorized/i);
  } finally {
    await close();
  }
});

test("binds to 127.0.0.1 by default with an ephemeral port", async () => {
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir: tmp() });
  const { url, port, close } = await server.start();
  try {
    expect(url).toBe(`http://127.0.0.1:${port}`);
    expect(port).toBeGreaterThan(0);
  } finally {
    await close();
  }
});
