import { existsSync, readFileSync } from "node:fs";
import { AUDIT_GENESIS, verifyAuditLog, type AuditRecord, type FileAuditLogOptions } from "./index.ts";

/**
 * Compliance export of the authoritative audit stream, for SIEM / retention
 * systems. The records are already the hash-chained NDJSON; the value an export
 * adds is an INTEGRITY MANIFEST — the chain is verified and the head hash is
 * emitted, so the consuming system can confirm the bundle is intact and matches
 * the server's retained HEAD (the anti-forgery anchor). Optional time-range /
 * type filters produce a scoped, still-attested slice.
 *
 * No secret ever appears: the log records hashes of already-redacted args and
 * results, never raw content — the export inherits that property unchanged.
 */
export interface ExportFilter {
  /** ISO-8601 inclusive lower bound on record `ts`. */
  since?: string;
  /** ISO-8601 inclusive upper bound on record `ts`. */
  until?: string;
  /** Keep only these record types (`tool_call` | `tool_result` | `model_request`). */
  types?: string[];
}

export interface AuditExportManifest {
  version: 1;
  genesis: string;
  /** Records in the SOURCE log (before filtering). */
  totalCount: number;
  /** Records in THIS export (after filtering). */
  count: number;
  /** Hash of the last record in the source log — the chain head. `null` if empty. */
  headHash: string | null;
  /** Whether the source chain verified at export time. */
  verified: boolean;
  /** First broken entry index, when `verified` is false. */
  brokenAt?: number;
  /** The filter applied, echoed for the consumer. Absent when unfiltered. */
  filter?: ExportFilter;
}

export interface AuditExport {
  manifest: AuditExportManifest;
  records: AuditRecord[];
}

export interface ExportAuditLogOptions extends FileAuditLogOptions {
  since?: string;
  until?: string;
  types?: string[];
}

/**
 * Read, verify, and (optionally) filter an audit log into a portable export with
 * an integrity manifest. A missing/empty log exports vacuously (verified, empty).
 */
export function exportAuditLog(path: string, opts: ExportAuditLogOptions = {}): AuditExport {
  const genesis = opts.genesis ?? AUDIT_GENESIS;
  const verify = verifyAuditLog(path, opts.genesis ? { genesis: opts.genesis } : {});

  const lines = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0)
    : [];
  const all: AuditRecord[] = lines.map((l) => JSON.parse(l) as AuditRecord);
  const headHash = all.length > 0 ? all[all.length - 1].hash : null;

  const { since, until, types } = opts;
  const records = all.filter((r) => {
    if (since && r.ts < since) return false;
    if (until && r.ts > until) return false;
    if (types && types.length > 0 && !types.includes(r.type)) return false;
    return true;
  });

  const filter: ExportFilter = {};
  if (since) filter.since = since;
  if (until) filter.until = until;
  if (types && types.length > 0) filter.types = types;

  return {
    manifest: {
      version: 1,
      genesis,
      totalCount: all.length,
      count: records.length,
      headHash,
      verified: verify.ok,
      ...(verify.brokenAt !== undefined ? { brokenAt: verify.brokenAt } : {}),
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    },
    records,
  };
}

/** Serialize an export as NDJSON: the manifest line first, then one record per line. */
export function auditExportToNdjson(exported: AuditExport): string {
  const lines = [JSON.stringify({ manifest: exported.manifest }), ...exported.records.map((r) => JSON.stringify(r))];
  return lines.join("\n") + "\n";
}
