import { hashCanonical } from "@openharness/audit";
import type { AuditSink, ToolDecision } from "@openharness/audit";

export interface GovernedCallRecord {
  /** Employee the decision was made for. */
  principal: string;
  /** Policy version the decision was made under (self-describing record). */
  policyVersion: string;
  tool: string;
  decision: ToolDecision;
  ruleId?: string;
  /** REDACTED args (hashed, never stored raw). */
  redactedArgs: unknown;
  /** REDACTED result, when the tool ran (hashed). Omit on a blocked call. */
  result?: unknown;
}

/**
 * Append a governed call to the gateway's AUTHORITATIVE hash-chained audit: a
 * `tool_call` entry (who, policy version, decision, and a hash of the REDACTED
 * args) and, when the tool actually ran, a `tool_result` entry (hash of the
 * REDACTED result). Raw args/results are never written — only canonical hashes.
 * The chain is server-side, so a patched local binary cannot skip it; the
 * harness's local chain is cross-checked against this one (divergence = tamper).
 */
export async function auditGovernedCall(sink: AuditSink, rec: GovernedCallRecord): Promise<void> {
  const server = rec.tool.startsWith("mcp__") ? rec.tool.split("__")[1] : undefined;
  await sink.record({
    type: "tool_call",
    tool: rec.tool,
    ...(server ? { server } : {}),
    decision: rec.decision,
    ...(rec.ruleId ? { ruleId: rec.ruleId } : {}),
    argsHash: hashCanonical(rec.redactedArgs),
    principal: rec.principal,
    policyVersion: rec.policyVersion,
  });
  if (rec.result !== undefined) {
    await sink.record({
      type: "tool_result",
      tool: rec.tool,
      redacted: true,
      resultHash: hashCanonical(rec.result),
    });
  }
}
