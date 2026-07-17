import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { AUDIT_GENESIS, chainHash, createFileAuditLog } from "./index.ts";
import { createAuditShipper, type AuditPush, type AuditPushResult } from "./shipper.ts";

const tmps: string[] = [];
afterAll(() => {
  // best-effort; tmp dirs are disposable
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "oh-shipper-"));
  tmps.push(d);
  return d;
}

/** Write N real chained tool_call records to a fresh log and return its path. */
function writeLog(n: number): string {
  const path = join(tmp(), "audit.jsonl");
  const sink = createFileAuditLog(path);
  for (let i = 0; i < n; i++) sink.record({ type: "tool_call", tool: `t${i}`, decision: "allow", argsHash: `h${i}` });
  return path;
}

/**
 * A fake server that mirrors `@openharness/server`'s chain-continuity semantics:
 * it retains a HEAD (seq, hash) and refuses anything that doesn't continue it —
 * a prevHash mismatch → 409 fork; a seq gap → 409 with `expected N`.
 */
function fakeServer(startHead: { seq: number; hash: string } | null = null) {
  let head = startHead;
  const ingested: string[] = [];
  const push: AuditPush = async (lines): Promise<AuditPushResult> => {
    let prevHash = head ? head.hash : AUDIT_GENESIS;
    let expectedSeq = head ? head.seq + 1 : 0;
    for (let i = 0; i < lines.length; i++) {
      const rec = JSON.parse(lines[i]) as Record<string, unknown> & { seq: number; prevHash: string; hash: string };
      if (rec.seq !== expectedSeq) return { status: 409, error: `entry ${i} seq gap (expected ${expectedSeq}, got ${rec.seq})` };
      if (rec.prevHash !== prevHash) return { status: 409, error: `entry ${i} prevHash mismatch (fork or re-chain from genesis)` };
      const { hash, ...withoutHash } = rec;
      if (chainHash(prevHash, withoutHash) !== hash) return { status: 400, error: `entry ${i} hash does not match its contents` };
      prevHash = rec.hash;
      expectedSeq += 1;
    }
    for (const l of lines) ingested.push(l);
    const last = JSON.parse(lines[lines.length - 1]) as { seq: number; hash: string };
    head = { seq: last.seq, hash: last.hash };
    return { status: 200, ingested: lines.length };
  };
  return { push, get ingested() { return ingested; }, get head() { return head; } };
}

test("ships the whole local tail to a fresh server and records the ack", async () => {
  const logPath = writeLog(5);
  const srv = fakeServer();
  const shipper = createAuditShipper({ logPath, push: srv.push });
  const r = await shipper.flush();
  expect(r.ok).toBe(true);
  expect(r.shipped).toBe(5);
  expect(r.ackedSeq).toBe(4);
  expect(srv.ingested.length).toBe(5);
});

test("is resumable across restart — a second shipper with the same state ships only NEW records, no duplicates", async () => {
  const logPath = writeLog(3);
  const srv = fakeServer();
  const statePath = `${logPath}.shipped.json`;

  await createAuditShipper({ logPath, statePath, push: srv.push }).flush();
  expect(srv.ingested.length).toBe(3);

  // Append two more records to the same log, then a FRESH shipper (new process).
  const sink = createFileAuditLog(logPath);
  sink.record({ type: "tool_call", tool: "t3", decision: "deny", argsHash: "h3" });
  sink.record({ type: "tool_call", tool: "t4", decision: "allow", argsHash: "h4" });

  const r = await createAuditShipper({ logPath, statePath, push: srv.push }).flush();
  expect(r.shipped).toBe(2); // only the new ones
  expect(r.ackedSeq).toBe(4);
  expect(srv.ingested.length).toBe(5); // no duplicates
});

test("batches large tails and ships every record", async () => {
  const logPath = writeLog(10);
  const srv = fakeServer();
  const shipper = createAuditShipper({ logPath, push: srv.push, batchSize: 3 });
  const r = await shipper.flush();
  expect(r.ok).toBe(true);
  expect(r.shipped).toBe(10);
  expect(srv.ingested.length).toBe(10);
});

test("a tampered local record trips the server 409 fork alarm — ship stops and the ack does NOT advance", async () => {
  const logPath = writeLog(4);
  const srv = fakeServer();
  // Tamper record #2 in place (rewrite its tool) WITHOUT re-chaining downstream —
  // its stored hash no longer matches, so from the server's view the chain forks.
  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
  const rec = JSON.parse(lines[2]) as Record<string, unknown>;
  rec.tool = "tampered";
  lines[2] = JSON.stringify(rec);
  writeFileSync(logPath, lines.map((l) => `${l}\n`).join(""));

  // batchSize:1 so 0 and 1 ship+ack, then the corrupt entry 2 stops the shipper.
  const r = await createAuditShipper({ logPath, push: srv.push, batchSize: 1 }).flush();
  expect(r.ok).toBe(false);
  expect(r.conflict).toBeTruthy();
  expect(r.ackedSeq).toBe(1); // acked 0 and 1, then stopped at the forked entry 2
});

test("a fork at the very first entry is a hard alarm, never fast-forwarded", async () => {
  const logPath = writeLog(3);
  // Server already holds a DIFFERENT chain at seq 0 (a genuine fork, not a gap).
  const srv = fakeServer({ seq: 0, hash: "some-other-chain-hash" });
  const r = await createAuditShipper({ logPath, push: srv.push }).flush();
  expect(r.ok).toBe(false);
  expect(r.conflict).toMatch(/expected 1|prevHash|fork/);
  expect(r.shipped).toBe(0);
});

test("benign resume after lost sidecar state: server is AHEAD, shipper fast-forwards past a seq gap", async () => {
  const logPath = writeLog(6);
  // Emulate: the server already ingested records 0..3 of THIS SAME chain, but the
  // local sidecar state was lost (fresh shipper thinks ackedSeq=-1).
  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
  const rec3 = JSON.parse(lines[3]) as { seq: number; hash: string };
  const srv = fakeServer({ seq: 3, hash: rec3.hash });
  const r = await createAuditShipper({ logPath, push: srv.push }).flush();
  expect(r.ok).toBe(true);
  expect(r.shipped).toBe(2); // records 4 and 5
  expect(r.ackedSeq).toBe(5);
});

test("a transient (5xx / network) failure is reported retryable and does NOT advance the ack", async () => {
  const logPath = writeLog(3);
  let calls = 0;
  const flaky: AuditPush = async () => {
    calls++;
    return { status: 503, error: "service unavailable" };
  };
  const r = await createAuditShipper({ logPath, push: flaky }).flush();
  expect(r.ok).toBe(false);
  expect(r.retryable).toBeTruthy();
  expect(r.conflict).toBeUndefined();
  expect(r.ackedSeq).toBe(-1);
  expect(calls).toBe(1);
});
