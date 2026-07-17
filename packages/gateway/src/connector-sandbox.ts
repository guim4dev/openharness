import { fork, type ChildProcess } from "node:child_process";
import type { Connector, ConnectorResult } from "./connectors/index.ts";
import type { ToolCatalog } from "./catalog.ts";
import type { ConnectorSessions } from "./sessions.ts";
import type { SandboxCallRequest, WorkerRequest } from "./connector-worker-protocol.ts";

export { handleWorkerRequest } from "./connector-worker-protocol.ts";
export type { SandboxCallRequest, WorkerReply, WorkerRequest } from "./connector-worker-protocol.ts";

/**
 * Deploy hardening §5 (recommended option B): out-of-process connector isolation.
 * A connector is the one component that makes arbitrary network calls with a real
 * org credential; in-process, a connector bug or a supply-chain compromise shares
 * the gateway's memory (every principal's in-flight requests, the broker handle).
 *
 * This moves the connector's `call()` behind a WARM, per-(principal, connector)
 * worker PROCESS: a separate OS process with its own memory and its own crash
 * domain. The credential is marshaled per call (never held on the connector), the
 * egress allowlist + forward-proxy tap travel INTO the worker (they already live
 * inside `call()`), and a worker crash is contained — it rejects that call and is
 * respawned lazily, never taking the gateway down.
 *
 * The seam is `SandboxHost` (where `call` actually runs). `ChildProcessSandboxHost`
 * is the reference impl; a deployment could swap a per-call container (option A) or
 * a microVM (option C) behind the same interface without touching the pipeline —
 * `ConnectorSessions` stays the only thing the governed pipeline sees.
 */

/** Static, network-free metadata for a connector, known in-process at boot. */
export interface ConnectorDescriptor {
  id: string;
  tools: ToolCatalog;
  allowHosts: string[];
}

/** Runs a connector's `call` "somewhere" — in-process, a worker, a container. */
export interface SandboxHost {
  invoke(principal: string, connectorId: string, req: SandboxCallRequest): Promise<ConnectorResult>;
  /** Number of live workers (for shutdown / metrics). */
  size(): number;
  close(): Promise<void>;
}

/** Build a `ConnectorSessions` whose instances run out-of-process via `host`. */
export function createSandboxedConnectorSessions(opts: {
  host: SandboxHost;
  descriptors: Record<string, ConnectorDescriptor>;
}): ConnectorSessions {
  return {
    for(principal, connectorId): Connector {
      const desc = opts.descriptors[connectorId];
      if (!desc) throw new Error(`unknown connector: ${connectorId}`);
      return {
        id: desc.id,
        tools: desc.tools,
        allowHosts: desc.allowHosts,
        call: (toolName, args, cred) => opts.host.invoke(principal, connectorId, { toolName, args, cred }),
      };
    },
    size: () => opts.host.size(),
  };
}

// ── ChildProcessSandboxHost: warm per-key worker processes ──────────────────

interface WorkerEntry {
  child: ChildProcess;
  pending: Map<number, { resolve: (r: ConnectorResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  nextId: number;
}

export interface ChildProcessSandboxHostOptions {
  /**
   * Absolute path (or file URL) to the worker entry module. Production: the
   * built-in `connector-worker.ts`. The worker is spawned once per
   * (principal, connector) and reused warm.
   */
  workerModule: string;
  /**
   * Absolute path (or file URL) to a module exporting
   * `factories: Record<string, () => Connector>` — the vetted first-party
   * connectors the worker may instantiate. Passed to the worker by path so the
   * subprocess resolves it itself (no closure crosses the boundary).
   */
  registryModule: string;
  /** Node runtime flags for the fork (e.g. `["--experimental-strip-types"]` for a `.ts` worker). */
  execArgv?: string[];
  /** Per-call timeout in ms (default 30s). A hung worker rejects and is killed. */
  callTimeoutMs?: number;
}

export class ChildProcessSandboxHost implements SandboxHost {
  private readonly workers = new Map<string, WorkerEntry>();
  private closed = false;
  private readonly opts: ChildProcessSandboxHostOptions;

  constructor(opts: ChildProcessSandboxHostOptions) {
    this.opts = opts;
  }

  invoke(principal: string, connectorId: string, req: SandboxCallRequest): Promise<ConnectorResult> {
    if (this.closed) return Promise.reject(new Error("sandbox host closed"));
    // INVARIANT: one worker serves exactly one (principal, connector). Reply
    // correlation trusts the worker's self-reported `id`, so a compromised
    // worker could cross-wire replies among ITS OWN in-flight calls — but every
    // such call is the same principal + connector + credential, so nothing
    // crosses a trust boundary. This holds ONLY while workers are never shared
    // across principals; a future pool that shares one must re-key correlation.
    const key = `${principal}\0${connectorId}`;
    const entry = this.workers.get(key) ?? this.spawn(key, connectorId);
    const id = entry.nextId++;
    const timeoutMs = this.opts.callTimeoutMs ?? 30_000;

    return new Promise<ConnectorResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        this.kill(key, entry);
        reject(new Error("connector call timed out"));
      }, timeoutMs);
      // Do not keep the event loop alive purely for this timer.
      if (typeof timer.unref === "function") timer.unref();
      entry.pending.set(id, { resolve, reject, timer });
      const msg: WorkerRequest = { id, ...req };
      entry.child.send(msg, (err) => {
        if (err) {
          const p = entry.pending.get(id);
          if (p) {
            clearTimeout(p.timer);
            entry.pending.delete(id);
            this.kill(key, entry);
            reject(err);
          }
        }
      });
    });
  }

  private spawn(key: string, connectorId: string): WorkerEntry {
    const child = fork(this.opts.workerModule, ["--connector", connectorId, "--registry", this.opts.registryModule], {
      execArgv: this.opts.execArgv ?? process.execArgv,
      // Isolate stdio; the worker communicates ONLY over the IPC channel.
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const entry: WorkerEntry = { child, pending: new Map(), nextId: 1 };

    child.on("message", (raw: unknown) => {
      // The worker runs the UNTRUSTED connector — treat its IPC as hostile. A
      // throw inside a 'message' listener becomes an uncaughtException that would
      // crash the SHARED gateway process (a single `process.send(null)` from a
      // compromised connector), defeating the very containment this sandbox
      // exists to provide. So validate the shape and never let it throw.
      if (raw === null || typeof raw !== "object") return;
      const m = raw as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
      if (typeof m.id !== "number") return;
      const p = entry.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      entry.pending.delete(m.id);
      if (m.ok === true) p.resolve((m.result ?? { content: [] }) as ConnectorResult);
      else p.reject(new Error(typeof m.error === "string" ? m.error : "connector error"));
    });

    const fail = (reason: string) => {
      // A crash / exit rejects every in-flight call and drops the worker; the
      // next invoke spawns a fresh one. One principal's crash can't wedge others.
      if (this.workers.get(key) === entry) this.workers.delete(key);
      for (const [, p] of entry.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      entry.pending.clear();
    };
    child.on("error", (e) => fail(`connector worker error: ${e.message}`));
    child.on("exit", (code, signal) => fail(`connector worker exited (code=${code} signal=${signal})`));

    this.workers.set(key, entry);
    return entry;
  }

  private kill(key: string, entry: WorkerEntry): void {
    if (this.workers.get(key) === entry) this.workers.delete(key);
    try {
      entry.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  size(): number {
    return this.workers.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [key, entry] of this.workers) this.kill(key, entry);
    this.workers.clear();
  }
}
