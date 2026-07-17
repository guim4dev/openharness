import { existsSync, readFileSync } from "node:fs";

/**
 * Cross-check the harness's LOCAL audit chain against the gateway's AUTHORITATIVE
 * one — the detection feature the gateway design calls for (spec §2 PEP #7:
 * "divergence is itself tamper evidence"). Each governed call should appear in
 * BOTH chains with the same `(tool, argsHash)`; a mismatch is tamper evidence:
 *
 *  - in the GATEWAY chain but missing locally → the local audit was skipped
 *    (a patched local binary that recorded nothing) or a local record was deleted.
 *  - in the LOCAL chain for a governed tool but missing on the gateway → the
 *    harness claims a call the authoritative server never recorded (forgery).
 *
 * The local chain is a SUPERSET (it also records local-only tools), so we compare
 * only the GOVERNED subset — the set of tools that appear in the gateway chain.
 * Multiset semantics: N identical calls must appear N times in both.
 */

export interface ReconcileResult {
  /** True when the two chains agree on every governed call. */
  ok: boolean;
  /** Governed calls matched in both chains (min count per key). */
  matched: number;
  /** In the gateway chain but missing locally — local audit skipped / a local record deleted. */
  onlyInGateway: { tool: string; argsHash: string }[];
  /** In the local chain for a governed tool but missing on the gateway — a forged local record. */
  onlyInLocal: { tool: string; argsHash: string }[];
}

interface Call {
  tool: string;
  argsHash: string;
}

function readToolCalls(path: string): Call[] {
  if (!existsSync(path)) return [];
  const out: Call[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    let rec: { type?: unknown; tool?: unknown; argsHash?: unknown };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue; // a corrupt line is a verifyAuditLog concern, not reconcile's
    }
    if (rec.type === "tool_call" && typeof rec.tool === "string" && typeof rec.argsHash === "string") {
      out.push({ tool: rec.tool, argsHash: rec.argsHash });
    }
  }
  return out;
}

const keyOf = (c: Call): string => `${c.tool}\n${c.argsHash}`;

function multiset(calls: Call[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of calls) m.set(keyOf(c), (m.get(keyOf(c)) ?? 0) + 1);
  return m;
}

function fromKey(key: string): { tool: string; argsHash: string } {
  const i = key.indexOf("\n");
  return { tool: key.slice(0, i), argsHash: key.slice(i + 1) };
}

export function reconcileAuditLogs(localPath: string, gatewayPath: string): ReconcileResult {
  const local = readToolCalls(localPath);
  const gateway = readToolCalls(gatewayPath);

  // The governed set is exactly the tools the gateway recorded — local-only
  // tools (never governed by the gateway) are legitimately absent there.
  const governed = new Set(gateway.map((c) => c.tool));
  const gw = multiset(gateway);
  const loc = multiset(local.filter((c) => governed.has(c.tool)));

  const onlyInGateway: Call[] = [];
  const onlyInLocal: Call[] = [];
  let matched = 0;

  for (const [key, n] of gw) {
    const l = loc.get(key) ?? 0;
    matched += Math.min(n, l);
    for (let i = 0; i < n - l; i++) onlyInGateway.push(fromKey(key));
  }
  for (const [key, l] of loc) {
    const n = gw.get(key) ?? 0;
    for (let i = 0; i < l - n; i++) onlyInLocal.push(fromKey(key));
  }

  return { ok: onlyInGateway.length === 0 && onlyInLocal.length === 0, matched, onlyInGateway, onlyInLocal };
}
