import type { UpstreamCredential } from "./broker.ts";
import type { Connector, ConnectorResult } from "./connectors/index.ts";

/**
 * The parent ⇄ worker IPC protocol for the out-of-process connector sandbox
 * (deploy hardening §5). Kept in its own module — with only erasable TypeScript
 * and type-only workspace imports, and NO `node:child_process` dependency — so
 * the worker entry can import it and run under `node --experimental-strip-types`
 * without pulling in the host's fork machinery.
 */

/** One marshaled call: what crosses the process boundary, in. */
export interface SandboxCallRequest {
  toolName: string;
  args: Record<string, unknown>;
  cred: UpstreamCredential;
}

export type WorkerRequest = { id: number } & SandboxCallRequest;
export type WorkerReply =
  | { id: number; ok: true; result: ConnectorResult }
  | { id: number; ok: false; error: string };

/**
 * The worker's pure request→reply logic, shared by the worker entry and tests.
 * A connector that throws maps to an `ok:false` reply — the failure is contained
 * in the worker and reported, never crashing it.
 */
export async function handleWorkerRequest(connector: Connector, req: WorkerRequest): Promise<WorkerReply> {
  try {
    const result = await connector.call(req.toolName, req.args, req.cred);
    return { id: req.id, ok: true, result };
  } catch (e) {
    return { id: req.id, ok: false, error: (e as Error)?.message ?? "connector error" };
  }
}
