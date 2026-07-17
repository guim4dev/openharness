import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Ships the local hash-chained audit log to the authoritative server anchor.
 *
 * The product's tamper-evidence claim lives on the SERVER: it retains a
 * per-source HEAD and refuses any submission that does not continue the last
 * accepted entry (see `@openharness/server`). But that anchor is only real if
 * something actually ships the local records to it — this is that shipper.
 *
 * Guarantees:
 *  - **At-least-once, resumable.** It tracks the highest server-acked `seq` in a
 *    sidecar state file, so a crash/restart resumes from the ack without
 *    duplicating or skipping. Only records past the ack are sent, in batches.
 *  - **A 409 is a loud integrity alarm, never silently retried past.** A prevHash
 *    mismatch means a fork / re-chain from genesis — a tampered or forked local
 *    log — so shipping STOPS and the ack does NOT advance. A *seq-gap* 409 where
 *    the server is simply AHEAD (e.g. the sidecar state was lost) is benign: the
 *    shipper fast-forwards its ack to the server's expected seq and resumes; a
 *    fork is still caught, because the next record's prevHash won't match.
 *  - **Never blocks enforcement.** Transport is injected (`push`); a transient
 *    failure (network / 5xx) is reported as retryable and the ack is untouched.
 *
 * Transport-agnostic on purpose: `@openharness/server` imports this package, so
 * the shipper cannot import it back — the HTTP binding is supplied by the caller.
 */

/** Structured push result — the shipper needs the STATUS to tell 409 from 5xx. */
export interface AuditPushResult {
  status: number;
  ingested?: number;
  /** Server error body (used to parse a seq-gap's expected seq). */
  error?: string;
}

/** Sends NDJSON lines to the server and reports the outcome (never throws on 4xx/5xx). */
export type AuditPush = (ndjsonLines: string[]) => Promise<AuditPushResult>;

export interface AuditShipperOptions {
  /** Path to the local hash-chained JSONL audit log. */
  logPath: string;
  /** Sidecar ack-state file. Default `<logPath>.shipped.json`. */
  statePath?: string;
  /** Transport: POSTs the lines to the server's `/audit` for one source. */
  push: AuditPush;
  /** Max records per POST. Default 256. */
  batchSize?: number;
}

export interface ShipResult {
  /** True when the local tail is fully shipped (or was already empty). */
  ok: boolean;
  /** Records newly acked in this flush. */
  shipped: number;
  /** Highest `seq` the server has confirmed. -1 when nothing acked yet. */
  ackedSeq: number;
  /** Set when a 409 fork/re-chain stopped shipping — a tamper alarm. */
  conflict?: string;
  /** Set when a transient error stopped shipping (safe to retry later). */
  retryable?: string;
}

interface ShipperState {
  ackedSeq: number;
}

function readState(statePath: string): ShipperState {
  if (!existsSync(statePath)) return { ackedSeq: -1 };
  try {
    const s = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ShipperState>;
    return { ackedSeq: typeof s.ackedSeq === "number" ? s.ackedSeq : -1 };
  } catch {
    return { ackedSeq: -1 };
  }
}

function writeState(statePath: string, state: ShipperState): void {
  writeFileSync(statePath, JSON.stringify(state));
}

/** The parsed local records with their raw lines, in seq order. */
function readLog(logPath: string): { seq: number; line: string }[] {
  if (!existsSync(logPath)) return [];
  const out: { seq: number; line: string }[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    let seq: number;
    try {
      seq = (JSON.parse(line) as { seq?: unknown }).seq as number;
    } catch {
      continue; // a corrupt tail line: skip (verifyAuditLog surfaces real corruption)
    }
    if (typeof seq === "number") out.push({ seq, line });
  }
  return out;
}

export interface AuditShipper {
  /** Ship everything past the ack. Idempotent; safe to call periodically + on close. */
  flush(): Promise<ShipResult>;
  /** The highest seq the server has confirmed (from the sidecar state). */
  ackedSeq(): number;
}

export function createAuditShipper(opts: AuditShipperOptions): AuditShipper {
  const statePath = opts.statePath ?? `${opts.logPath}.shipped.json`;
  const batchSize = opts.batchSize ?? 256;
  const state = readState(statePath);

  return {
    ackedSeq: () => state.ackedSeq,
    async flush(): Promise<ShipResult> {
      const records = readLog(opts.logPath);
      let shipped = 0;
      // Bound the loop: at most one send per batch plus a fast-forward per batch.
      const maxIterations = Math.ceil(records.length / batchSize) + records.length + 2;
      for (let iter = 0; iter < maxIterations; iter++) {
        const tail = records.filter((r) => r.seq > state.ackedSeq);
        if (tail.length === 0) return { ok: true, shipped, ackedSeq: state.ackedSeq };

        const batch = tail.slice(0, batchSize);
        const res = await opts.push(batch.map((r) => r.line));

        if (res.status >= 200 && res.status < 300) {
          const lastSeq = batch[batch.length - 1].seq;
          shipped += batch.length;
          state.ackedSeq = lastSeq;
          writeState(statePath, state);
          continue; // ship the next batch, if any
        }

        // A 409 (fork / seq gap) or 400 (a record whose hash doesn't match its
        // contents — a corrupt local log) is a permanent CONTENT rejection: an
        // integrity alarm, never retried past. The one benign case is a seq-gap
        // 409 where the server is simply AHEAD (lost sidecar state) — fast-forward
        // the ack to the server's expected seq and resume; a fork is still caught,
        // because the next record's prevHash won't match.
        if (res.status === 409 || res.status === 400) {
          const m = /expected (\d+)/.exec(res.error ?? "");
          if (res.status === 409 && m) {
            const expected = Number(m[1]);
            if (expected - 1 > state.ackedSeq) {
              state.ackedSeq = expected - 1;
              writeState(statePath, state);
              continue; // resume from where the server actually is
            }
          }
          return { ok: false, shipped, ackedSeq: state.ackedSeq, conflict: res.error ?? "audit chain conflict (fork, re-chain, or corrupt record)" };
        }

        // Network / 5xx / anything else: transient. Do not advance the ack.
        return { ok: false, shipped, ackedSeq: state.ackedSeq, retryable: res.error ?? `push failed (status ${res.status})` };
      }
      // Should be unreachable given maxIterations; treat as a non-advancing conflict.
      return { ok: false, shipped, ackedSeq: state.ackedSeq, conflict: "shipper did not converge (non-advancing chain state)" };
    },
  };
}
