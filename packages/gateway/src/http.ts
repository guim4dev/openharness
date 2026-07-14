import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createReplayGuard, isDeny } from "./auth.ts";
import { dpopFromHttp } from "./dpop-http.ts";
import { createGateway, type GatewayPipeline } from "./server.ts";
import type { ToolSpec } from "./catalog.ts";

/**
 * A deployable HTTP entry for the gateway. Each request is authenticated at the
 * edge with DPoP (token + request-bound proof + key-binding); only then is a
 * per-request, stateless MCP server spun up with the caller's Principal pinned
 * into the governed pipeline. There is no token passthrough and no session
 * affinity — every request re-proves possession of the bound key, which is what
 * makes a leaked token worthless off the client's machine.
 *
 * `pipeline` supplies everything the governed pipeline needs EXCEPT
 * `resolvePrincipal` — that is derived per request from the validated DPoP
 * headers, so identity can never be spoofed by the caller.
 */
export interface GatewayHttpOptions {
  catalog: ToolSpec[];
  pipeline: Omit<GatewayPipeline, "resolvePrincipal">;
  /** The gateway's ed25519 public key (PEM) — verifies the access token. */
  gatewayPublicKeyPem: string;
  host?: string;
  port?: number;
  /** MCP endpoint path (default "/mcp"). */
  path?: string;
  /** Where non-fatal errors (request failures, cleanup failures) are logged. Default: console.error. */
  logger?: (message: string, err?: unknown) => void;
}

export interface GatewayHttpServer {
  /** Full URL to the MCP endpoint (host + path). */
  url: string;
  port: number;
  close(): Promise<void>;
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
}

function serverError(res: ServerResponse): void {
  if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
  if (!res.writableEnded) {
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
  }
}

export async function startGatewayHttp(opts: GatewayHttpOptions): Promise<GatewayHttpServer> {
  const path = opts.path ?? "/mcp";
  const host = opts.host ?? "127.0.0.1";
  const log = opts.logger ?? ((m: string, err?: unknown) => console.error(`[openharness/gateway] ${m}`, err ?? ""));
  // One replay guard for the server: a DPoP proof id authenticates exactly one
  // request, so a captured proof cannot be replayed inside its freshness window.
  const replayGuard = createReplayGuard();

  const httpServer = createServer((req, res) => {
    // The handler is fully self-contained: it never rejects (see the try/catch
    // in handle). A stray rejection here would be an unhandled rejection that
    // takes down the shared server for every principal, so we still guard it.
    handle(req, res).catch((err) => {
      log("request handler crashed", err);
      serverError(res);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (!url.startsWith(path)) {
      res.writeHead(404).end();
      return;
    }

    // 1. Edge auth — DPoP over HTTP, before anything else touches the request.
    const principal = dpopFromHttp(
      req.headers as Record<string, string | undefined>,
      { method: req.method ?? "POST", url },
      opts.gatewayPublicKeyPem,
      Date.now(),
      replayGuard,
    );
    if (isDeny(principal)) {
      unauthorized(res);
      return;
    }

    // 2. Per-request stateless MCP server with the caller's Principal pinned.
    //    Any failure below is contained here: we send a 500 and never let the
    //    promise reject (which would crash the process for all principals).
    const gateway = createGateway({
      catalog: opts.catalog,
      pipeline: { ...opts.pipeline, resolvePrincipal: () => principal },
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close().catch((err) => log("transport close failed", err));
      void gateway.close().catch((err) => log("gateway close failed", err));
    });
    try {
      await gateway.server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log("failed to handle request", err);
      serverError(res);
    }
  }

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, host, () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  const url = `http://${host}:${addr.port}${path}`;

  return {
    url,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => httpServer.close((e) => (e ? reject(e) : resolve()))),
  };
}
