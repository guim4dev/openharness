# @openharness/audit

A hash-chained JSONL audit log of an agent's external calls.

Records the governance data plane's decisions — tool calls (the winning policy
decision plus a SHA-256 of the ALREADY-REDACTED args), tool results, and model
requests — as an append-only, hash-chained JSONL file. External calls only;
prompts and raw args are never written, only hashes, so a secret can't be
recovered from the log. `verifyAuditLog` recomputes the chain to catch
accidental corruption and naive in-place edits; the local chain is keyless and
genesis-anchored, so the real tamper-evidence anchor is the server's retained
per-source HEAD (`@openharness/server`). Consumed by `@openharness/core`;
depends on nothing else in the monorepo.

## API

- `createFileAuditLog(path, opts?) -> AuditSink` — append-only file sink;
  `sink.record(entry)` writes one chained record, `sink.close()` flushes.
- `InMemoryAuditSink` — an `AuditSink` that keeps records in memory (for tests).
- `verifyAuditLog(path, opts?) -> VerifyResult` — recompute the chain end to end;
  reports `ok` and, on failure, the `brokenAt` entry.
- Primitives: `canonicalJSON(value)`, `hashCanonical(value)`,
  `chainHash(prevHash, recordWithoutHash)`.
- Constants & types: `AUDIT_GENESIS`, `AUDIT_VERSION`; `AuditEntry`
  (`ToolCallEntry` | `ToolResultEntry` | `ModelRequestEntry`), `AuditRecord`,
  `AuditSink`, `ToolDecision`, `VerifyResult`, `FileAuditLogOptions`.

## Usage

```ts
import { createFileAuditLog, verifyAuditLog } from "@openharness/audit";

const sink = createFileAuditLog("./audit/acme.jsonl");
await sink.record({
  type: "tool_call",
  tool: "mcp__github__create_issue",
  decision: "allow",
  argsHash: hashOfRedactedArgs,
});
await sink.close?.();

const result = verifyAuditLog("./audit/acme.jsonl");
if (!result.ok) console.error(`chain broken at entry ${result.brokenAt}`);
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.
