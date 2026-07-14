import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAuditLog, verifyAuditLog } from "@openharness/audit";
import { auditGovernedCall } from "./audit-endpoint.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oh-gw-audit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("an allowed call with a result appends tool_call + tool_result with attribution + hashes", async () => {
  const path = join(dir, "audit.jsonl");
  const sink = createFileAuditLog(path);
  await auditGovernedCall(sink, {
    principal: "alice@acme.test",
    policyVersion: "0.1.0",
    tool: "mcp__github__list_issues",
    decision: "allow",
    ruleId: "mcp__github__*",
    redactedArgs: { owner: "zzowner", repo: "zzrepo" },
    result: { issue: "zzresultvalue" },
  });
  await sink.close?.();

  const lines = await readLines(path);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({
    type: "tool_call",
    tool: "mcp__github__list_issues",
    server: "github",
    decision: "allow",
    principal: "alice@acme.test",
    policyVersion: "0.1.0",
  });
  expect(typeof lines[0].argsHash).toBe("string");
  expect(lines[1]).toMatchObject({ type: "tool_result", tool: "mcp__github__list_issues", redacted: true });
  // Raw arg/result VALUES are NOT in the log — only their hashes.
  const serialized = JSON.stringify(lines);
  expect(serialized).not.toContain("zzowner");
  expect(serialized).not.toContain("zzrepo");
  expect(serialized).not.toContain("zzresultvalue");
  expect(verifyAuditLog(path).ok).toBe(true);
});

test("a denied call appends only a tool_call (no result), decision deny", async () => {
  const path = join(dir, "deny.jsonl");
  const sink = createFileAuditLog(path);
  await auditGovernedCall(sink, {
    principal: "bob@acme.test",
    policyVersion: "0.1.0",
    tool: "mcp__mail__send",
    decision: "deny",
    redactedArgs: { to: "x@evil.com" },
  });
  await sink.close?.();

  const lines = await readLines(path);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ type: "tool_call", decision: "deny" });
  expect(verifyAuditLog(path).ok).toBe(true);
});

test("a tampered line breaks the chain (authoritative integrity)", async () => {
  const path = join(dir, "tamper.jsonl");
  const sink = createFileAuditLog(path);
  await auditGovernedCall(sink, {
    principal: "a",
    policyVersion: "0.1.0",
    tool: "read",
    decision: "allow",
    redactedArgs: {},
    result: {},
  });
  await sink.close?.();

  const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim());
  const forged = JSON.parse(lines[0]) as Record<string, unknown>;
  forged.decision = "deny"; // mutate a recorded field without re-chaining
  await writeFile(path, `${JSON.stringify(forged)}\n${lines.slice(1).join("\n")}\n`);
  expect(verifyAuditLog(path).ok).toBe(false);
});
