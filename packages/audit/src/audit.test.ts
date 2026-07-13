import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_GENESIS,
  InMemoryAuditSink,
  canonicalJSON,
  createFileAuditLog,
  hashCanonical,
  verifyAuditLog,
} from "./index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oh-audit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

test("file sink writes a hash-chained JSONL envelope per entry", async () => {
  const path = join(dir, "audit.jsonl");
  const sink = createFileAuditLog(path);
  sink.record({ type: "tool_call", tool: "read", decision: "allow", argsHash: hashCanonical({ path: "/a" }) });
  sink.record({ type: "tool_result", tool: "read", redacted: false, resultHash: hashCanonical(["x"]) });
  await sink.close?.();

  const lines = await readLines(path);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ v: 1, seq: 0, type: "tool_call", prevHash: AUDIT_GENESIS });
  expect(typeof lines[0].hash).toBe("string");
  expect(lines[0].ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
  // chain links: entry 1's prevHash == entry 0's hash
  expect(lines[1].seq).toBe(1);
  expect(lines[1].prevHash).toBe(lines[0].hash);
});

test("verifyAuditLog passes on a clean log", async () => {
  const path = join(dir, "clean.jsonl");
  const sink = createFileAuditLog(path);
  for (let i = 0; i < 5; i++) {
    sink.record({ type: "tool_call", tool: `t${i}`, decision: "allow", argsHash: hashCanonical({ i }) });
  }
  await sink.close?.();
  expect(verifyAuditLog(path)).toEqual({ ok: true });
});

test("verifyAuditLog fails after mutating any line (tamper detection)", async () => {
  const path = join(dir, "tamper.jsonl");
  const sink = createFileAuditLog(path);
  sink.record({ type: "tool_call", tool: "a", decision: "allow", argsHash: "h0" });
  sink.record({ type: "tool_call", tool: "b", decision: "deny", argsHash: "h1" });
  sink.record({ type: "tool_call", tool: "c", decision: "allow", argsHash: "h2" });
  await sink.close?.();
  expect(verifyAuditLog(path).ok).toBe(true);

  const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim().length > 0);
  // Flip the decision on the middle entry without recomputing its hash.
  const middle = JSON.parse(lines[1]) as Record<string, unknown>;
  middle.decision = "allow";
  lines[1] = JSON.stringify(middle);
  await writeFile(path, lines.join("\n") + "\n");

  expect(verifyAuditLog(path)).toEqual({ ok: false, brokenAt: 1 });
});

test("verifyAuditLog detects a mutated hash field", async () => {
  const path = join(dir, "hash.jsonl");
  const sink = createFileAuditLog(path);
  sink.record({ type: "model_request", provider: "anthropic", model: "claude", tokensIn: 10 });
  await sink.close?.();

  const rec = (await readLines(path))[0];
  rec.hash = "deadbeef";
  await writeFile(path, JSON.stringify(rec) + "\n");
  expect(verifyAuditLog(path)).toEqual({ ok: false, brokenAt: 0 });
});

test("file sink resumes an existing chain and stays verifiable", async () => {
  const path = join(dir, "resume.jsonl");
  const s1 = createFileAuditLog(path);
  s1.record({ type: "tool_call", tool: "a", decision: "allow", argsHash: "h0" });
  await s1.close?.();

  const s2 = createFileAuditLog(path);
  s2.record({ type: "tool_call", tool: "b", decision: "allow", argsHash: "h1" });
  await s2.close?.();

  const lines = await readLines(path);
  expect(lines.map((l) => l.seq)).toEqual([0, 1]);
  expect(lines[1].prevHash).toBe(lines[0].hash);
  expect(verifyAuditLog(path)).toEqual({ ok: true });
});

test("missing file verifies vacuously", () => {
  expect(verifyAuditLog(join(dir, "nope.jsonl"))).toEqual({ ok: true });
});

test("InMemoryAuditSink chains records like the file sink", () => {
  const sink = new InMemoryAuditSink();
  sink.record({ type: "tool_call", tool: "a", decision: "allow", argsHash: "h0" });
  sink.record({ type: "tool_call", tool: "b", decision: "deny", argsHash: "h1" });
  expect(sink.records).toHaveLength(2);
  expect(sink.records[0].prevHash).toBe(AUDIT_GENESIS);
  expect(sink.records[1].prevHash).toBe(sink.records[0].hash);
});

test("canonicalJSON is key-order stable and drops undefined", () => {
  expect(canonicalJSON({ b: 1, a: 2 })).toBe(canonicalJSON({ a: 2, b: 1 }));
  expect(canonicalJSON({ a: 1, server: undefined })).toBe(canonicalJSON({ a: 1 }));
});

test("hashCanonical fingerprints without exposing the value", () => {
  const secret = "sk-LIVE-deadBEEF";
  const h = hashCanonical({ token: secret });
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(h).not.toContain(secret);
});
