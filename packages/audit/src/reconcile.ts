import { existsSync, readFileSync } from "node:fs";
import { verifyAuditLog } from "./index.ts";

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
 *
 * FAIL CLOSED on untrusted input. Both files are attacker-influenced, so a result
 * of `ok: true` is only produced when BOTH chains verify (`verifyAuditLog`) AND
 * every non-blank line parses into a well-formed record. Any parse error, broken
 * chain, or malformed `tool_call` (e.g. a non-string `argsHash`) is collected in
 * `problems` and forces `ok: false` — a corrupt/truncated/HTML download of the
 * authoritative log must never read as "no divergence".
 *
 * KNOWN LIMITATIONS (the authoritative anchor is still the server's retained HEAD,
 * not this two-file diff): (1) comparison is a multiset, so a REORDERING of
 * governed calls is not flagged; (2) the governed scope is derived from the tools
 * that appear in the gateway chain, so a forged local call of a governed tool the
 * gateway recorded ZERO times is not surfaced. Closing either needs an ordered,
 * seq-aligned compare and an authoritative governed-tool set passed in.
 */

export interface ReconcileResult {
  /** True ONLY when both chains verified, both parsed cleanly, and every governed call agrees. */
  ok: boolean;
  /** Governed calls matched in both chains (min count per key). */
  matched: number;
  /** In the gateway chain but missing locally — local audit skipped / a local record deleted. */
  onlyInGateway: { tool: string; argsHash: string }[];
  /** In the local chain for a governed tool but missing on the gateway — a forged local record. */
  onlyInLocal: { tool: string; argsHash: string }[];
  /** Input-trust failures (unverifiable chain, unparseable/malformed lines). Non-empty ⇒ `ok` is false. */
  problems: string[];
}

interface Call {
  tool: string;
  argsHash: string;
}

function readToolCalls(path: string, label: string, problems: string[]): Call[] {
  if (!existsSync(path)) return [];
  const out: Call[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    let rec: { type?: unknown; tool?: unknown; argsHash?: unknown };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      // Do NOT swallow: an unparseable line means the file isn't a trustworthy
      // chain (also caught by verifyAuditLog, but flag it here so a caller that
      // skips verification still fails closed).
      problems.push(`${label} line ${i}: unparseable`);
      continue;
    }
    if (rec.type !== "tool_call") continue; // tool_result / model_request etc. are not compared
    if (typeof rec.tool === "string" && typeof rec.argsHash === "string") {
      out.push({ tool: rec.tool, argsHash: rec.argsHash });
    } else {
      // A tool_call with a mis-typed key would otherwise vanish from the diff,
      // letting a tampered line "disappear". Flag it rather than drop it.
      problems.push(`${label} line ${i}: malformed tool_call (tool/argsHash not strings)`);
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
  const problems: string[] = [];

  // Verify each chain first — a broken/tampered/corrupt file is not a trustworthy
  // basis for a "no divergence" verdict. (verifyAuditLog treats a missing/empty
  // file as vacuously ok, which is fine: nothing governed, nothing to diverge.)
  const vLocal = verifyAuditLog(localPath);
  if (!vLocal.ok) problems.push(`local chain broken at entry ${vLocal.brokenAt}`);
  const vGateway = verifyAuditLog(gatewayPath);
  if (!vGateway.ok) problems.push(`gateway chain broken at entry ${vGateway.brokenAt}`);

  const local = readToolCalls(localPath, "local", problems);
  const gateway = readToolCalls(gatewayPath, "gateway", problems);

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

  const ok = problems.length === 0 && onlyInGateway.length === 0 && onlyInLocal.length === 0;
  return { ok, matched, onlyInGateway, onlyInLocal, problems };
}
