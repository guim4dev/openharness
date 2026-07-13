import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @openharness/audit — a tamper-evident, hash-chained JSONL audit log for
 * external-call events (tool calls, tool results, model requests).
 *
 * SECURITY INVARIANT: an audit entry NEVER carries raw secrets or any
 * prompt/message/conversation content. Callers pass only already-redacted,
 * hashed, or otherwise non-sensitive fields. Arg/result payloads are recorded
 * as a SHA-256 over their canonical JSON (a fingerprint), never verbatim.
 */

/** Fixed genesis `prevHash` for the first entry of a chain. */
export const AUDIT_GENESIS = "openharness-audit-genesis-v1";

/** Log-format version stamped on every written record. */
export const AUDIT_VERSION = 1 as const;

/** The decision recorded for a tool call. `ask` is split into its outcome. */
export type ToolDecision = "allow" | "deny" | "ask-approved" | "ask-denied";

/**
 * A tool call was evaluated by policy. `argsHash` is the SHA-256 of the canonical
 * JSON of the ALREADY-REDACTED args — never the raw args, so a secret in an
 * argument cannot be recovered from the log.
 */
export interface ToolCallEntry {
  type: "tool_call";
  tool: string;
  /** MCP server the tool belongs to, parsed from `mcp__<server>__<tool>`. */
  server?: string;
  decision: ToolDecision;
  /** `match` pattern of the winning rule; absent when the default decided. */
  ruleId?: string;
  argsHash: string;
}

/** A tool result re-entered context. `resultHash` fingerprints the redacted result. */
export interface ToolResultEntry {
  type: "tool_result";
  tool: string;
  /** Whether redaction actually changed the result before it was fingerprinted. */
  redacted: boolean;
  resultHash: string;
}

/** A provider/model request. Token counts included only when present on the payload. */
export interface ModelRequestEntry {
  type: "model_request";
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}

/** The union a caller hands to `sink.record()`. */
export type AuditEntry = ToolCallEntry | ToolResultEntry | ModelRequestEntry;

/** A written record = the entry plus chain/envelope fields. */
export type AuditRecord = AuditEntry & {
  v: typeof AUDIT_VERSION;
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
};

/** A durable audit destination. */
export interface AuditSink {
  record(entry: AuditEntry): void | Promise<void>;
  close?(): Promise<void>;
}

export interface FileAuditLogOptions {
  /** Override the genesis prevHash (must match on verify). Default: AUDIT_GENESIS. */
  genesis?: string;
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization: object keys are sorted, and keys whose value
 * is `undefined` are dropped (so an omitted optional and an explicit `undefined`
 * hash identically — the write side spreads `undefined`, the parsed side omits
 * the key entirely, and both must produce the same canonical string).
 */
export function canonicalJSON(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
}

/** SHA-256 (hex) of the canonical JSON of `value`. Used for arg/result fingerprints. */
export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

/** Chain hash for a record: sha256(prevHash + canonicalJSON(recordWithoutHash)). */
function chainHash(prevHash: string, recordWithoutHash: Record<string, unknown>): string {
  return createHash("sha256").update(prevHash + canonicalJSON(recordWithoutHash)).digest("hex");
}

/** Build the sealed record for an entry given the running chain state. */
function seal(entry: AuditEntry, seq: number, prevHash: string): AuditRecord {
  const base = { v: AUDIT_VERSION, seq, ts: new Date().toISOString(), ...entry, prevHash };
  const hash = chainHash(prevHash, base);
  return { ...base, hash } as AuditRecord;
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

/**
 * Append hash-chained JSONL to `path`. If the file already exists and is
 * non-empty, the chain resumes from its last entry (continuing `seq`/`prevHash`).
 * Each `record()` is flushed synchronously so ordering and durability need no
 * async coordination.
 */
export function createFileAuditLog(path: string, opts: FileAuditLogOptions = {}): AuditSink {
  const genesis = opts.genesis ?? AUDIT_GENESIS;
  mkdirSync(dirname(path), { recursive: true });

  let seq = 0;
  let prevHash = genesis;
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      const last = JSON.parse(lines[lines.length - 1]) as AuditRecord;
      seq = last.seq + 1;
      prevHash = last.hash;
    }
  }

  const fd = openSync(path, "a");
  let closed = false;

  return {
    record(entry: AuditEntry): void {
      if (closed) throw new Error("audit sink is closed");
      const sealed = seal(entry, seq, prevHash);
      writeSync(fd, JSON.stringify(sealed) + "\n");
      seq = sealed.seq + 1;
      prevHash = sealed.hash;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

/** An in-memory sink that keeps the sealed records. For tests and inspection. */
export class InMemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  private seq = 0;
  private prevHash: string;

  constructor(genesis: string = AUDIT_GENESIS) {
    this.prevHash = genesis;
  }

  record(entry: AuditEntry): void {
    const sealed = seal(entry, this.seq, this.prevHash);
    this.records.push(sealed);
    this.seq = sealed.seq + 1;
    this.prevHash = sealed.hash;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  /** 0-based index (== seq) of the first entry that fails to verify. */
  brokenAt?: number;
}

/**
 * Recompute the chain over the file and report the first broken entry. A missing
 * or empty file verifies vacuously. An entry is broken when it is unparseable, its
 * `seq` is out of order, its `prevHash` does not match the running hash, or its
 * stored `hash` does not match the recomputation — i.e. any mutation of any line.
 */
export function verifyAuditLog(path: string, opts: FileAuditLogOptions = {}): VerifyResult {
  const genesis = opts.genesis ?? AUDIT_GENESIS;
  if (!existsSync(path)) return { ok: true };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);

  let prevHash = genesis;
  for (let i = 0; i < lines.length; i++) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      return { ok: false, brokenAt: i };
    }
    if (typeof record.hash !== "string") return { ok: false, brokenAt: i };
    if (record.seq !== i) return { ok: false, brokenAt: i };
    if (record.prevHash !== prevHash) return { ok: false, brokenAt: i };

    const { hash, ...withoutHash } = record;
    if (chainHash(prevHash, withoutHash) !== hash) return { ok: false, brokenAt: i };
    prevHash = hash as string;
  }
  return { ok: true };
}
