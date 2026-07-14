import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileAuditLog } from "./index.ts";
import { auditExportToNdjson, exportAuditLog } from "./export.ts";

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oh-audit-exp-"));
  logPath = join(dir, "audit.log");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  const sink = createFileAuditLog(logPath);
  void sink.record({ type: "tool_call", tool: "github__list_issues", decision: "allow", argsHash: "a1" });
  void sink.record({ type: "tool_result", tool: "github__list_issues", redacted: false, resultHash: "r1" });
  void sink.record({ type: "model_request", provider: "anthropic", model: "claude-sonnet-5" });
}

test("exports every record with an integrity manifest (verified + head hash)", () => {
  seed();
  const exported = exportAuditLog(logPath);
  expect(exported.manifest.verified).toBe(true);
  expect(exported.manifest.totalCount).toBe(3);
  expect(exported.manifest.count).toBe(3);
  // Head hash equals the last record's hash — the chain head a server retains.
  const last = exported.records[exported.records.length - 1];
  expect(exported.manifest.headHash).toBe(last.hash);
  expect(exported.records.map((r) => r.type)).toEqual(["tool_call", "tool_result", "model_request"]);
});

test("a missing log exports vacuously (verified, empty, null head)", () => {
  const exported = exportAuditLog(join(dir, "does-not-exist.log"));
  expect(exported.manifest.verified).toBe(true);
  expect(exported.manifest.totalCount).toBe(0);
  expect(exported.manifest.headHash).toBeNull();
  expect(exported.records).toEqual([]);
});

test("filters by type but keeps the SOURCE head hash + total count", () => {
  seed();
  const exported = exportAuditLog(logPath, { types: ["tool_call"] });
  expect(exported.manifest.count).toBe(1);
  expect(exported.manifest.totalCount).toBe(3); // source total, not the filtered count
  expect(exported.records[0].type).toBe("tool_call");
  expect(exported.manifest.filter).toEqual({ types: ["tool_call"] });
  // Head hash is the whole log's head, independent of the filter.
  const raw = readFileSync(logPath, "utf8").trim().split("\n");
  expect(exported.manifest.headHash).toBe(JSON.parse(raw[raw.length - 1]).hash);
});

test("filters by time range (inclusive) on record ts", () => {
  seed();
  const all = exportAuditLog(logPath).records;
  const midTs = all[1].ts;
  // until = mid keeps records 0..1; since = mid keeps records 1..2.
  expect(exportAuditLog(logPath, { until: midTs }).records.length).toBeGreaterThanOrEqual(2);
  const sinceMid = exportAuditLog(logPath, { since: midTs });
  expect(sinceMid.records.every((r) => r.ts >= midTs)).toBe(true);
});

test("reports a broken chain (tampered line) as unverified with brokenAt", () => {
  seed();
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  const rec = JSON.parse(lines[1]);
  rec.argsHash = "tampered";
  lines[1] = JSON.stringify(rec);
  writeFileSync(logPath, lines.join("\n") + "\n");

  const exported = exportAuditLog(logPath);
  expect(exported.manifest.verified).toBe(false);
  expect(exported.manifest.brokenAt).toBe(1);
  // Records are still returned (for inspection) even when integrity fails.
  expect(exported.records.length).toBe(3);
});

test("auditExportToNdjson emits a manifest line then one line per record", () => {
  seed();
  const ndjson = auditExportToNdjson(exportAuditLog(logPath));
  const lines = ndjson.trim().split("\n");
  expect(lines.length).toBe(4); // manifest + 3 records
  expect(JSON.parse(lines[0]).manifest.version).toBe(1);
  expect(JSON.parse(lines[1]).type).toBe("tool_call");
});
