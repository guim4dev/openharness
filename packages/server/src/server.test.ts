import { afterAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  BundleVerificationError,
  bundleDefinition,
  generateKeypair,
  verifyBundle,
  writeBundle,
  type Bundle,
} from "@openharness/bundle";
import { AUDIT_GENESIS, InMemoryAuditSink, verifyAuditLog, type AuditRecord } from "@openharness/audit";
import { createOpenHarnessServer, fetchBundle, pushAudit } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, "..", "..", "..", "harnesses", "example");

/** Build a valid, genesis-anchored hash chain of `n` audit records for POST /audit tests. */
function chain(n: number, genesis: string = AUDIT_GENESIS): AuditRecord[] {
  const sink = new InMemoryAuditSink(genesis);
  for (let i = 0; i < n; i++) sink.record({ type: "model_request", provider: "anthropic", model: `m${i}` });
  return sink.records;
}
const line = (rec: unknown): string => JSON.stringify(rec);
const body = (recs: unknown[]): string => recs.map((r) => `${line(r)}\n`).join("");

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

    const noAuthAudit = await fetch(`${url}/audit`, { method: "POST", body: body(chain(1)) });
    expect(noAuthAudit.status).toBe(401);
    expect(await noAuthAudit.json()).toEqual({ error: "unauthorized" });

    const withAuthBundle = await fetch(`${url}/bundle`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withAuthBundle.status).toBe(200);

    const withAuthAudit = await fetch(`${url}/audit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: body(chain(1)),
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

test("(d) POST /audit accepts a valid genesis batch then a valid continuation, appending both verbatim", async () => {
  const auditDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const { url, close } = await server.start();
  try {
    const recs = chain(3); // seq 0,1,2 anchored at genesis
    const filePath = join(auditDir, "ingested-default.jsonl");

    const res = await fetch(`${url}/audit`, { method: "POST", body: body(recs.slice(0, 2)) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2 });
    expect(readFileSync(filePath, "utf8").trim().split("\n")).toEqual([line(recs[0]), line(recs[1])]);

    // seq 2 continues the retained head (prevHash == recs[1].hash) -> accepted, appended
    const res2 = await fetch(`${url}/audit`, { method: "POST", body: body([recs[2]]) });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ingested: 1 });
    const written = readFileSync(filePath, "utf8").trim().split("\n");
    expect(written).toEqual(recs.map(line));

    // the server's retained copy is itself a valid chain end to end
    expect(verifyAuditLog(filePath)).toEqual({ ok: true });
  } finally {
    await close();
  }
});

test("(d1) POST /audit rejects a re-chain from genesis once a head exists, appending nothing", async () => {
  const auditDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const { url, close } = await server.start();
  try {
    const filePath = join(auditDir, "ingested-default.jsonl");
    const original = chain(2);
    await fetch(`${url}/audit`, { method: "POST", body: body(original) });
    const before = readFileSync(filePath, "utf8");

    // A forger rewrote their local log and re-POSTs a fresh chain from genesis.
    const forged = chain(2); // distinct records, but prevHash of entry 0 == AUDIT_GENESIS
    const res = await fetch(`${url}/audit`, { method: "POST", body: body(forged) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/audit rejected/i);

    // NOT appended: file byte-for-byte unchanged.
    expect(readFileSync(filePath, "utf8")).toBe(before);
  } finally {
    await close();
  }
});

test("(d2) POST /audit rejects a fork off an earlier entry, appending nothing", async () => {
  const auditDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const { url, close } = await server.start();
  try {
    const filePath = join(auditDir, "ingested-default.jsonl");
    const recs = chain(2); // head becomes recs[1] (seq 1)
    await fetch(`${url}/audit`, { method: "POST", body: body(recs) });
    const before = readFileSync(filePath, "utf8");

    // Fork: a chain re-anchored on recs[0].hash (rewriting history after seq 0).
    const forkBranch = chain(1, recs[0].hash); // entry seq 0, prevHash == recs[0].hash
    const res = await fetch(`${url}/audit`, { method: "POST", body: body(forkBranch) });
    expect(res.status).toBe(409);

    expect(readFileSync(filePath, "utf8")).toBe(before);
  } finally {
    await close();
  }
});

test("(d3) POST /audit rejects a seq gap, appending nothing", async () => {
  const auditDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const { url, close } = await server.start();
  try {
    const filePath = join(auditDir, "ingested-default.jsonl");
    const recs = chain(2); // head becomes recs[1] (seq 1)
    await fetch(`${url}/audit`, { method: "POST", body: body(recs) });
    const before = readFileSync(filePath, "utf8");

    // Continues the head's hash but skips seq 2 -> claims seq 5.
    const next = chain(3).slice(-1)[0]; // some valid-looking record...
    const gapped = { ...next, prevHash: recs[1].hash, seq: 5 };
    const res = await fetch(`${url}/audit`, { method: "POST", body: body([gapped]) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/seq gap/i);

    expect(readFileSync(filePath, "utf8")).toBe(before);
  } finally {
    await close();
  }
});

test("(d4) POST /audit rejects a batch with any malformed JSON line (400), appending nothing", async () => {
  const auditDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const { url, close } = await server.start();
  try {
    const filePath = join(auditDir, "ingested-default.jsonl");
    const recs = chain(2);
    // First line is a perfectly valid genesis entry; second line is garbage.
    const res = await fetch(`${url}/audit`, {
      method: "POST",
      body: `${line(recs[0])}\n{not valid json}\n`,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/malformed JSON/i);

    // The whole batch was dropped: the valid first line was NOT appended.
    expect(existsSync(filePath)).toBe(false);
  } finally {
    await close();
  }
});

test("(d5) POST /audit rejects an entry whose hash does not match its contents (400)", async () => {
  const auditDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const { url, close } = await server.start();
  try {
    const filePath = join(auditDir, "ingested-default.jsonl");
    const [rec] = chain(1);
    // Tamper the payload but keep the stored hash: recomputation must fail.
    const tampered = { ...rec, model: "evil-swapped-model" };
    const res = await fetch(`${url}/audit`, { method: "POST", body: body([tampered]) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/hash does not match/i);
    expect(existsSync(filePath)).toBe(false);
  } finally {
    await close();
  }
});

test("(d6) POST /audit isolates chains per source (x-oh-source)", async () => {
  const auditDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const { url, close } = await server.start();
  try {
    const a = chain(2);
    const b = chain(2); // an independent genesis chain for a different source
    const postA = await fetch(`${url}/audit`, {
      method: "POST",
      headers: { "x-oh-source": "laptop-a" },
      body: body(a),
    });
    const postB = await fetch(`${url}/audit`, {
      method: "POST",
      headers: { "x-oh-source": "laptop-b" },
      body: body(b),
    });
    expect(postA.status).toBe(200);
    expect(postB.status).toBe(200);

    expect(verifyAuditLog(join(auditDir, "ingested-laptop-a.jsonl"))).toEqual({ ok: true });
    expect(verifyAuditLog(join(auditDir, "ingested-laptop-b.jsonl"))).toEqual({ ok: true });

    // A path-unsafe source id is rejected.
    const bad = await fetch(`${url}/audit`, {
      method: "POST",
      headers: { "x-oh-source": "../escape" },
      body: body(chain(1)),
    });
    expect(bad.status).toBe(400);
  } finally {
    await close();
  }
});

test("(d7) the retained HEAD survives a restart: recovered from the stored file", async () => {
  const auditDir = tmp();
  const recs = chain(3);

  const first = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const s1 = await first.start();
  try {
    await fetch(`${s1.url}/audit`, { method: "POST", body: body(recs.slice(0, 2)) });
  } finally {
    await s1.close();
  }

  // A fresh instance (empty in-memory head map) over the SAME dir must recover
  // head=recs[1] from disk: it rejects a re-chain but accepts the real continuation.
  const second = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const s2 = await second.start();
  try {
    const rechain = await fetch(`${s2.url}/audit`, { method: "POST", body: body(chain(2)) });
    expect(rechain.status).toBe(409);

    const cont = await fetch(`${s2.url}/audit`, { method: "POST", body: body([recs[2]]) });
    expect(cont.status).toBe(200);
    expect(verifyAuditLog(join(auditDir, "ingested-default.jsonl"))).toEqual({ ok: true });
  } finally {
    await s2.close();
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
    const result = await pushAudit(url, token, chain(2).map(line));
    expect(result.ingested).toBe(2);

    await expect(pushAudit(url, undefined, chain(1).map(line))).rejects.toThrow(/401|unauthorized/i);
  } finally {
    await close();
  }
});

test("bearer auth: a wrong or truncated token is rejected (constant-time compare)", async () => {
  const bundlesDir = tmp();
  const { privateKey } = generateKeypair();
  writeBundle(bundleDefinition(exampleDir, privateKey), join(bundlesDir, "example.ohbundle"));

  const token = "the-real-token-value";
  const server = createOpenHarnessServer({ bundlesDir, auditDir: tmp(), token });
  const { url, close } = await server.start();
  try {
    for (const attempt of ["Bearer wrong", `Bearer ${token}x`, `Bearer ${token.slice(0, 5)}`, token]) {
      const res = await fetch(`${url}/bundle`, { headers: { authorization: attempt } });
      expect(res.status).toBe(401);
    }
    // The exact token still works.
    const ok = await fetch(`${url}/bundle`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
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

test("audit continuity: a case-variant source cannot desync the HEAD and inject a fork", async () => {
  const auditDir = tmp();
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir });
  const { url, close } = await server.start();
  try {
    // Establish a chain under one casing.
    const first = await fetch(`${url}/audit`, { method: "POST", headers: { "x-oh-source": "laptop-a" }, body: body(chain(3)) });
    expect(first.status).toBe(200);
    // Re-submit from genesis under a DIFFERENT casing (same file on a
    // case-insensitive FS). Must be refused as a fork, not bootstrapped afresh.
    const fork = await fetch(`${url}/audit`, { method: "POST", headers: { "x-oh-source": "Laptop-A" }, body: body(chain(3)) });
    expect(fork.status).toBe(409);
    // The retained file stays a single valid chain.
    expect(verifyAuditLog(join(auditDir, "ingested-laptop-a.jsonl")).ok).toBe(true);
  } finally {
    await close();
  }
});

test("GET /bundle ignores a structurally-invalid .ohbundle instead of 500ing the endpoint", async () => {
  const bundlesDir = tmp();
  const { privateKey } = generateKeypair();
  writeBundle(bundleDefinition(exampleDir, privateKey), join(bundlesDir, "good.ohbundle"));
  // A stray file: valid JSON, no usable manifest.
  writeFileSync(join(bundlesDir, "broken.ohbundle"), JSON.stringify({ foo: 1 }));

  const server = createOpenHarnessServer({ bundlesDir, auditDir: tmp() });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/bundle`);
    expect(res.status).toBe(200); // the good bundle is returned; the stray file didn't take the endpoint down
    expect((await res.json()).manifest.name).toBe("example");
  } finally {
    await close();
  }
});

test("POST /audit rejects an oversized body with 413 (no unbounded buffering)", async () => {
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir: tmp() });
  const { url, close } = await server.start();
  try {
    const huge = "x".repeat(1_048_576 + 1024); // just over the 1 MiB cap
    const res = await fetch(`${url}/audit`, { method: "POST", headers: { "x-oh-source": "big" }, body: huge });
    expect(res.status).toBe(413);
  } finally {
    await close();
  }
});

test("a configured-but-empty token does NOT silently disable auth (fail-closed misconfig)", async () => {
  const server = createOpenHarnessServer({ bundlesDir: tmp(), auditDir: tmp(), token: "" });
  const { url, close } = await server.start();
  try {
    // /health stays open; a sensitive route is enforced (not opened by the empty token).
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/bundle`)).status).toBe(401);
  } finally {
    await close();
  }
});
