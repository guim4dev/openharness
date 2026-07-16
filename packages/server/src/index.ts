import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_GENESIS, chainHash } from "@openharness/audit";
import type { Bundle } from "@openharness/bundle";

/**
 * @openharness/server — the DUMB, LAST piece of the data plane: a thin bundle
 * host + audit sink over node:http.
 *
 * No dashboard, no SSO, no org model. Enforcement already happened in-process
 * in the harness (policy engine); this server distributes signed bundles and is
 * the AUTHORITATIVE anchor for the audit trail: for each source it retains the
 * last accepted `{seq, hash}` HEAD and refuses any submission that does not
 * continue it. A client that rewrote its local log and re-POSTed (re-chain from
 * genesis, a fork, or a seq gap) is rejected — the local hash-chain alone is
 * keyless and forgeable, so the server's retained copy is what makes tampering
 * evident. See `@openharness/audit` for the honest integrity note.
 */

/** The last audit entry this server has accepted for a given source. */
interface RetainedHead {
  seq: number;
  hash: string;
}

/** Per-instance mutable state: the retained audit HEAD for each source id. */
interface ServerState {
  auditHeads: Map<string, RetainedHead>;
}

/** Source ids become filenames, so keep them to a safe, injection-free charset. */
const SOURCE_ID = /^[A-Za-z0-9._-]+$/;

export interface OpenHarnessServerOptions {
  /** Directory containing `.ohbundle` files. Read on every `GET /bundle`. */
  bundlesDir: string;
  /** Directory audit NDJSON is appended into (created on demand). */
  auditDir: string;
  /** When set, `GET /bundle` and `POST /audit` require `authorization: Bearer <token>`. */
  token?: string;
  /** Bind address. Default `127.0.0.1` (never binds wider unless told to). */
  host?: string;
  /** Bind port. Default `0` (OS-assigned ephemeral port). */
  port?: number;
}

export interface StartedOpenHarnessServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface OpenHarnessServer {
  start(): Promise<StartedOpenHarnessServer>;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** Max accepted request body. A single audit record is tiny; this is a generous
 *  ceiling that stops an unbounded POST from exhausting memory. */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overLimit = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Past the cap, stop buffering (memory stays bounded) but keep the stream
      // flowing to `end` so we can answer with a clean 413 rather than killing
      // the socket mid-upload (which the client sees as a connection error).
      if (size > MAX_BODY_BYTES) {
        overLimit = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overLimit) reject(new BodyTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

class BodyTooLargeError extends Error {}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  // Auth is disabled ONLY when no token is configured (undefined) — the local-dev
  // default. A configured-but-empty token (e.g. an unset env var resolving to "")
  // is a misconfiguration and must NOT silently disable auth: fall through and
  // enforce (a normal client can't produce the matching empty bearer).
  if (token === undefined) return true;
  const provided = req.headers.authorization;
  if (typeof provided !== "string") return false;
  // Constant-time comparison. We hash both sides to fixed-length (32-byte)
  // SHA-256 digests before `timingSafeEqual` so the compare is undefined-safe
  // (a missing/short header can't throw) and leaks NOTHING about length —
  // comparing the raw strings would either throw on unequal length or short-
  // circuit, revealing how long the expected token is.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(a, b);
}

/** Resolve the audit log id from `x-oh-source` header or `?source=`; default `default`. */
function resolveSource(req: IncomingMessage, url: URL): string {
  const header = req.headers["x-oh-source"];
  const fromHeader = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  // Lowercase the id: the retained-HEAD map is keyed by this string while the log
  // file is `ingested-<source>.jsonl`. On a case-insensitive filesystem
  // (macOS/Windows) `laptop-a` and `Laptop-A` are DISTINCT map keys but the SAME
  // file — a stale cache under one casing would then accept a fork appended under
  // the other. Normalizing keeps the map key and the filename in lockstep.
  return (fromHeader ?? url.searchParams.get("source") ?? "default").toLowerCase();
}

/**
 * The retained HEAD for `source`: from in-memory state, else recovered from the
 * tail of the stored file so restarts stay authoritative. `null` = no entries yet.
 */
function loadHead(state: ServerState, source: string, filePath: string): RetainedHead | null {
  const cached = state.auditHeads.get(source);
  if (cached) return cached;
  if (existsSync(filePath)) {
    const lines = readFileSync(filePath, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 0) {
      try {
        const last = JSON.parse(lines[lines.length - 1]) as { seq: number; hash: string };
        const head = { seq: last.seq, hash: last.hash };
        state.auditHeads.set(source, head);
        return head;
      } catch {
        // A corrupt tail on a server-written file: treat as no head rather than
        // wedging ingestion. (Should not happen — the server only ever appends
        // records it already validated.)
      }
    }
  }
  return null;
}

/** The newest `.ohbundle` in `dir` (by `manifest.createdAt`), optionally filtered by `name`. */
function findBundle(dir: string, name: string | null): Bundle | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ohbundle"));

  let best: Bundle | null = null;
  for (const file of files) {
    let bundle: Bundle;
    try {
      bundle = JSON.parse(readFileSync(join(dir, file), "utf8")) as Bundle;
    } catch {
      continue; // ignore unreadable/corrupt files rather than failing the whole listing
    }
    // Skip a structurally-invalid bundle (valid JSON but no usable manifest):
    // reading `manifest.createdAt` off it would throw and 500 the whole endpoint,
    // taking bundle distribution down for one stray file.
    if (typeof bundle?.manifest?.name !== "string" || typeof bundle.manifest.createdAt !== "string") continue;
    if (name && bundle.manifest.name !== name) continue;
    if (!best || bundle.manifest.createdAt > best.manifest.createdAt) best = bundle;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenHarnessServerOptions,
  state: ServerState,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && url.pathname === "/bundle") {
    if (!isAuthorized(req, opts.token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const bundle = findBundle(opts.bundlesDir, url.searchParams.get("name"));
    if (!bundle) {
      sendJson(res, 404, { error: "no bundle found" });
      return;
    }
    sendJson(res, 200, bundle, { "x-oh-version": bundle.manifest.version });
    return;
  }

  if (method === "POST" && url.pathname === "/audit") {
    if (!isAuthorized(req, opts.token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const source = resolveSource(req, url);
    if (!SOURCE_ID.test(source)) {
      sendJson(res, 400, { error: "invalid source id" });
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
        return;
      }
      throw e;
    }
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      sendJson(res, 200, { ingested: 0 });
      return;
    }

    // (i) Every line must parse to a JSON object carrying the chain fields. A
    // single malformed line rejects the WHOLE batch — nothing is appended.
    const records: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        sendJson(res, 400, { error: "audit rejected: malformed JSON line" });
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        sendJson(res, 400, { error: "audit rejected: entry is not a JSON object" });
        return;
      }
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.seq !== "number" || typeof rec.prevHash !== "string" || typeof rec.hash !== "string") {
        sendJson(res, 400, { error: "audit rejected: entry missing chain fields (seq, prevHash, hash)" });
        return;
      }
      records.push(rec);
    }

    // (ii) The batch must CONTINUE this source's retained HEAD, and be internally
    // chained. We recompute every hash from the head (or genesis, for a brand-new
    // source) so a re-chain from genesis, a fork, or a seq gap is refused. This is
    // what makes the server — not the forgeable local file — authoritative.
    mkdirSync(opts.auditDir, { recursive: true });
    const filePath = join(opts.auditDir, `ingested-${source}.jsonl`);
    const head = loadHead(state, source, filePath);

    let prevHash = head ? head.hash : AUDIT_GENESIS;
    let expectedSeq = head ? head.seq + 1 : 0;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.prevHash !== prevHash) {
        const why =
          i === 0
            ? head
              ? "does not continue the retained head (prevHash mismatch — fork or re-chain from genesis)"
              : "must start from the audit genesis"
            : "internal chain break (prevHash)";
        sendJson(res, 409, { error: `audit rejected: entry ${i} ${why}` });
        return;
      }
      if (rec.seq !== expectedSeq) {
        sendJson(res, 409, {
          error: `audit rejected: entry ${i} seq gap (expected ${expectedSeq}, got ${String(rec.seq)})`,
        });
        return;
      }
      const { hash, ...withoutHash } = rec;
      if (chainHash(prevHash, withoutHash) !== hash) {
        sendJson(res, 400, { error: `audit rejected: entry ${i} hash does not match its contents` });
        return;
      }
      prevHash = hash as string;
      expectedSeq += 1;
    }

    // The whole batch verified: append verbatim and advance the retained HEAD.
    appendFileSync(filePath, lines.map((l) => `${l}\n`).join(""));
    const last = records[records.length - 1];
    state.auditHeads.set(source, { seq: last.seq as number, hash: last.hash as string });

    sendJson(res, 200, { ingested: lines.length });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Create the thin bundle host + audit sink. Binds to `opts.host` (default
 * `127.0.0.1`) and `opts.port` (default `0`, OS-assigned). Call `.start()` to
 * actually listen.
 */
export function createOpenHarnessServer(opts: OpenHarnessServerOptions): OpenHarnessServer {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const state: ServerState = { auditHeads: new Map() };

  return {
    start(): Promise<StartedOpenHarnessServer> {
      return new Promise((resolve, reject) => {
        const server = createHttpServer((req, res) => {
          handleRequest(req, res, opts, state).catch((e: unknown) => {
            if (!res.headersSent) sendJson(res, 500, { error: String((e as Error)?.message ?? e) });
            else res.end();
          });
        });
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const boundPort = typeof addr === "object" && addr ? addr.port : port;
          resolve({
            url: `http://${host}:${boundPort}`,
            port: boundPort,
            close: () =>
              new Promise<void>((res, rej) => {
                server.close((err) => (err ? rej(err) : res()));
              }),
          });
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Client helpers (global fetch — Node 22+)
// ---------------------------------------------------------------------------

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** GET `<serverUrl>/bundle` and return the parsed, still-unverified bundle. Callers must run `verifyBundle`. */
export async function fetchBundle(serverUrl: string, token?: string, name?: string): Promise<Bundle> {
  const url = new URL("/bundle", serverUrl);
  if (name) url.searchParams.set("name", name);
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`fetchBundle failed: ${res.status} ${res.statusText} ${text}`);
  }
  return (await res.json()) as Bundle;
}

/** POST NDJSON audit lines to `<serverUrl>/audit`. Returns how many lines the server ingested. */
export async function pushAudit(
  serverUrl: string,
  token: string | undefined,
  ndjsonLines: string[],
): Promise<{ ingested: number }> {
  const body = ndjsonLines.map((l) => (l.endsWith("\n") ? l : `${l}\n`)).join("");
  const res = await fetch(new URL("/audit", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/x-ndjson", ...authHeaders(token) },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`pushAudit failed: ${res.status} ${res.statusText} ${text}`);
  }
  return (await res.json()) as { ingested: number };
}
