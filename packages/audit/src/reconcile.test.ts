import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createFileAuditLog, hashCanonical } from "./index.ts";
import { reconcileAuditLogs } from "./reconcile.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "oh-reconcile-"));
}

/** A local-side tool_call record (buildPolicyExtension shape): argsHash over redacted args. */
function localCall(sink: ReturnType<typeof createFileAuditLog>, tool: string, args: unknown): void {
  sink.record({ type: "tool_call", tool, decision: "allow", argsHash: hashCanonical(args) });
}

/** A gateway-side tool_call record (auditGovernedCall shape): same argsHash + principal/policyVersion. */
function gatewayCall(sink: ReturnType<typeof createFileAuditLog>, tool: string, args: unknown): void {
  sink.record({ type: "tool_call", tool, decision: "allow", argsHash: hashCanonical(args), principal: "a", policyVersion: "1" });
}

test("identical governed calls reconcile clean", async () => {
  const dir = tmp();
  const localPath = join(dir, "local.jsonl");
  const gwPath = join(dir, "gw.jsonl");
  const local = createFileAuditLog(localPath);
  const gw = createFileAuditLog(gwPath);

  for (const args of [{ owner: "a" }, { owner: "b" }]) {
    localCall(local, "mcp__gw__list", args);
    gatewayCall(gw, "mcp__gw__list", args);
  }
  // A LOCAL-ONLY tool (never governed by the gateway) must be ignored, not flagged.
  localCall(local, "read", { path: "/x" });

  const r = reconcileAuditLogs(localPath, gwPath);
  expect(r.ok).toBe(true);
  expect(r.matched).toBe(2);
  expect(r.onlyInGateway).toHaveLength(0);
  expect(r.onlyInLocal).toHaveLength(0);
});

test("a governed call the gateway recorded but the local chain lacks = tamper (patched binary skipped local audit)", async () => {
  const dir = tmp();
  const localPath = join(dir, "local.jsonl");
  const gwPath = join(dir, "gw.jsonl");
  const local = createFileAuditLog(localPath);
  const gw = createFileAuditLog(gwPath);

  // Gateway saw two calls; the local binary only recorded ONE (skipped the second).
  localCall(local, "mcp__gw__write", { id: 1 });
  gatewayCall(gw, "mcp__gw__write", { id: 1 });
  gatewayCall(gw, "mcp__gw__write", { id: 2 });

  const r = reconcileAuditLogs(localPath, gwPath);
  expect(r.ok).toBe(false);
  expect(r.onlyInGateway).toEqual([{ tool: "mcp__gw__write", argsHash: hashCanonical({ id: 2 }) }]);
  expect(r.onlyInLocal).toHaveLength(0);
});

test("a governed-tool call the LOCAL chain claims but the gateway never recorded = forgery", async () => {
  const dir = tmp();
  const localPath = join(dir, "local.jsonl");
  const gwPath = join(dir, "gw.jsonl");
  const local = createFileAuditLog(localPath);
  const gw = createFileAuditLog(gwPath);

  gatewayCall(gw, "mcp__gw__read", { id: 1 });
  localCall(local, "mcp__gw__read", { id: 1 });
  localCall(local, "mcp__gw__read", { id: 999 }); // a governed-tool call absent from the authoritative chain

  const r = reconcileAuditLogs(localPath, gwPath);
  expect(r.ok).toBe(false);
  expect(r.onlyInLocal).toEqual([{ tool: "mcp__gw__read", argsHash: hashCanonical({ id: 999 }) }]);
  expect(r.onlyInGateway).toHaveLength(0);
});

test("missing files reconcile vacuously (nothing governed, nothing to diverge)", () => {
  const dir = tmp();
  const r = reconcileAuditLogs(join(dir, "nope-local.jsonl"), join(dir, "nope-gw.jsonl"));
  expect(r.ok).toBe(true);
  expect(r.matched).toBe(0);
  expect(r.problems).toHaveLength(0);
});

test("FAILS CLOSED when the gateway file is not a valid chain (corrupt / HTML error page)", () => {
  // A failed HTTPS fetch of the authoritative log (502 page, truncated download)
  // must NOT reconcile as "no divergence" — that would make the tamper gate pass
  // on unreadable input.
  const dir = tmp();
  const localPath = join(dir, "local.jsonl");
  const gwPath = join(dir, "gw.jsonl");
  localCall(createFileAuditLog(localPath), "mcp__gw__delete", { id: 1 });
  writeFileSync(gwPath, "<html><body>502 Bad Gateway</body></html>\n");

  const r = reconcileAuditLogs(localPath, gwPath);
  expect(r.ok).toBe(false);
  expect(r.problems.join(" ")).toMatch(/gw\.jsonl|gateway|chain|verif/i);
});

test("FAILS CLOSED when a chain is tampered (hash no longer matches its contents)", () => {
  const dir = tmp();
  const localPath = join(dir, "local.jsonl");
  const gwPath = join(dir, "gw.jsonl");
  localCall(createFileAuditLog(localPath), "mcp__gw__x", { id: 1 });
  const gw = createFileAuditLog(gwPath);
  gatewayCall(gw, "mcp__gw__x", { id: 1 });
  // Edit the tool name in place WITHOUT recomputing the hash → broken chain.
  const forged = readFileSync(gwPath, "utf8").replace('"mcp__gw__x"', '"HACKED"');
  writeFileSync(gwPath, forged);

  const r = reconcileAuditLogs(localPath, gwPath);
  expect(r.ok).toBe(false);
  expect(r.problems.length).toBeGreaterThan(0);
});

test("FAILS CLOSED on a malformed tool_call record (non-string argsHash) instead of silently dropping it", () => {
  const dir = tmp();
  const localPath = join(dir, "local.jsonl");
  const gwPath = join(dir, "gw.jsonl");
  const local = createFileAuditLog(localPath);
  gatewayCall(createFileAuditLog(gwPath), "mcp__gw__x", { id: 1 });
  localCall(local, "mcp__gw__x", { id: 1 });
  // A tool_call whose argsHash is numeric: the chain hash is still valid (record()
  // seals whatever it is given), so verifyAuditLog passes — reconcile must not
  // silently skip it.
  (local as unknown as { record: (e: unknown) => void }).record({
    type: "tool_call",
    tool: "mcp__gw__x",
    decision: "allow",
    argsHash: 12345,
  });

  const r = reconcileAuditLogs(localPath, gwPath);
  expect(r.ok).toBe(false);
  expect(r.problems.join(" ")).toMatch(/malformed|tool_call/i);
});
