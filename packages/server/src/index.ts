import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bundle } from "@openharness/bundle";

/**
 * @openharness/server — the DUMB, LAST piece of the data plane: a thin bundle
 * host + audit sink over node:http. Zero external dependencies.
 *
 * No dashboard, no SSO, no org model. Enforcement already happened in-process
 * in the harness (policy engine); this server only distributes signed bundles
 * and durably receives the audit trail they produced.
 */

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
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
    if (name && bundle.manifest?.name !== name) continue;
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
    const body = await readBody(req);
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    mkdirSync(opts.auditDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const filePath = join(opts.auditDir, `ingested-${day}.jsonl`);
    if (lines.length > 0) appendFileSync(filePath, lines.map((l) => `${l}\n`).join(""));

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

  return {
    start(): Promise<StartedOpenHarnessServer> {
      return new Promise((resolve, reject) => {
        const server = createHttpServer((req, res) => {
          handleRequest(req, res, opts).catch((e: unknown) => {
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
