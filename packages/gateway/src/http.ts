import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createReplayGuard, isDeny, signServerAuth } from "./auth.ts";
import { dpopFromHttp, SERVER_AUTH_HEADER } from "./dpop-http.ts";
import { createGateway, type GatewayPipeline } from "./server.ts";
import { exchangeToken, type IdpVerifier } from "./token-exchange.ts";
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
  /**
   * The gateway's ed25519 PRIVATE key (PEM). When set, every response is signed
   * (`x-oh-gateway-auth`, bound to the request's DPoP proof) so the client can
   * verify it is talking to the gateway whose `pubkey` its definition pinned —
   * not a fake. Omit only for dev/tests that don't exercise server auth.
   */
  gatewayPrivateKeyPem?: string;
  host?: string;
  port?: number;
  /** MCP endpoint path (default "/mcp"). */
  path?: string;
  /**
   * IdP verifier for the OAuth 2.1 token-exchange endpoint. When set (with the
   * private key), `POST <tokenPath>` exchanges an IdP subject token for a
   * DPoP-bound gateway token (deploy hardening §3). Omit for the dev path where
   * tokens are minted out of band.
   */
  idp?: IdpVerifier;
  /** Token-exchange endpoint path (default "/token"). */
  tokenPath?: string;
  /** Minted-token lifetime in ms (default 5 min). */
  tokenTtlMs?: number;
  /**
   * Approval admin surface (fail-closed server-side approval). When set, a
   * distinct admin bearer token gates `GET <adminPath>/approvals` (the pending
   * list, server-rendered) and `POST <adminPath>/approvals/<id>` ({approved,
   * by?}) to resolve them — so a policy `ask` over the deployable HTTP entry is
   * answerable instead of always timing out to deny. Omit to leave `ask` on the
   * timeout-deny default. This token is NOT a DPoP token; it is an out-of-band
   * operator credential.
   */
  adminToken?: string;
  /**
   * Per-approver bearer tokens (approver identity -> token). When set, the
   * approval surface authenticates the approver by their token and uses that
   * IDENTITY as the resolution's `by` — so `requireSecondPerson` becomes a real
   * control (the approver can't be spoofed via the request body). `adminToken`
   * still works as a single operator (identity "admin"). Approver names should
   * match the requester principal shape (e.g. an email) so self-approval is
   * detected. Tokens come from the deployment (env / secret store), not config.
   */
  approvers?: Record<string, string>;
  /** Approval admin path prefix (default "/admin"). */
  adminPath?: string;
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Constant-time bearer check — no length leak, no early return on mismatch. */
function bearerMatches(header: string | undefined, expected: string): boolean {
  const got = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Authenticate an approval-admin bearer to an approver IDENTITY (or undefined).
 * A per-approver token resolves to that approver's name; the single `adminToken`
 * resolves to "admin". Every candidate is checked with a constant-time compare.
 */
function authenticateApprover(
  header: string | undefined,
  adminToken: string | undefined,
  approvers: Record<string, string> | undefined,
): string | undefined {
  if (adminToken && bearerMatches(header, adminToken)) return "admin";
  if (approvers) {
    for (const [name, token] of Object.entries(approvers)) {
      if (bearerMatches(header, token)) return name;
    }
  }
  return undefined;
}

/**
 * Read a JSON request body up to a small cap (admin actions are tiny). On
 * overflow the socket is DESTROYED (not just left draining) and a timeout bounds
 * a slow-loris body, so an admin-token holder can't hang the handler with an
 * oversized or never-ending stream. Settles exactly once.
 */
async function readJsonBody(req: IncomingMessage, capBytes = 64 * 1024, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (v: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        /* already gone */
      }
      settle(undefined);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > capBytes) {
        try {
          req.destroy();
        } catch {
          /* already gone */
        }
        settle(undefined);
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      try {
        settle(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        settle(undefined);
      }
    });
    req.on("error", () => settle(undefined));
  });
}

export async function startGatewayHttp(opts: GatewayHttpOptions): Promise<GatewayHttpServer> {
  const path = opts.path ?? "/mcp";
  const tokenPath = opts.tokenPath ?? "/token";
  // A path must be a real absolute route. An empty string would make every
  // `startsWith` match — silently shadowing every route (e.g. tokenPath:"" would
  // route every POST into the token exchange, making /mcp unreachable).
  const adminPath = opts.adminPath ?? "/admin";
  if (!path.startsWith("/")) throw new Error(`gateway path must start with "/" (got ${JSON.stringify(path)})`);
  if (!tokenPath.startsWith("/")) throw new Error(`gateway tokenPath must start with "/" (got ${JSON.stringify(tokenPath)})`);
  if (opts.adminToken && !adminPath.startsWith("/"))
    throw new Error(`gateway adminPath must start with "/" (got ${JSON.stringify(adminPath)})`);
  // Route match with a boundary: exactly the path, or the path followed by a
  // query string — so `/token` does NOT also match `/tokenfoo` or `/token/x`.
  const routeIs = (u: string, base: string): boolean => u === base || u.startsWith(`${base}?`);
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

  const hdr = (h: Record<string, string | undefined>, k: string): string | undefined => h[k] ?? h[k.toLowerCase()];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";

    // 0. Token exchange (deploy hardening §3): NOT DPoP-authenticated — it is the
    //    bootstrap that ISSUES the DPoP-bound token, gated instead by the IdP
    //    subject token. Only mounted when an IdP verifier + signing key are set.
    if ((req.method ?? "").toUpperCase() === "POST" && routeIs(url, tokenPath) && opts.idp && opts.gatewayPrivateKeyPem) {
      const h = req.headers as Record<string, string | undefined>;
      const auth = hdr(h, "authorization");
      const subjectToken = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const keyB64 = hdr(h, "x-oh-dpop-key");
      const clientPublicKeyPem = keyB64 ? Buffer.from(keyB64, "base64url").toString() : "";
      const result = await exchangeToken(
        {
          subjectToken,
          clientPublicKeyPem,
          harnessId: hdr(h, "x-oh-harness") ?? "",
          defVersion: hdr(h, "x-oh-defversion") ?? "",
          sessionId: hdr(h, "x-oh-session") ?? "",
        },
        { idp: opts.idp, gatewayPrivateKeyPem: opts.gatewayPrivateKeyPem, ttlMs: opts.tokenTtlMs ?? 300_000, now: Date.now() },
      );
      if ("deny" in result) {
        unauthorized(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ access_token: result.token, token_type: "DPoP", expires_in: Math.floor(result.expiresInMs / 1000) }),
      );
      return;
    }

    // 0b. Approval admin surface (fail-closed server-side approval). Gated by an
    //     out-of-band bearer (NOT DPoP). The presented token authenticates an
    //     APPROVER IDENTITY (a per-approver token, or the single `adminToken` as
    //     "admin"); that identity — not a request-body field — is the `by` used
    //     to resolve, so `requireSecondPerson` can't be spoofed. `GET
    //     <adminPath>/approvals` lists pending items; `POST .../<id>` resolves one.
    if ((opts.adminToken || opts.approvers) && url.startsWith(`${adminPath}/approvals`)) {
      const bearer = hdr(req.headers as Record<string, string | undefined>, "authorization");
      const approver = authenticateApprover(bearer, opts.adminToken, opts.approvers);
      if (!approver) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const method = (req.method ?? "").toUpperCase();
      const rest = url.slice(`${adminPath}/approvals`.length).split("?")[0];
      if (method === "GET" && (rest === "" || rest === "/")) {
        sendJson(res, 200, { pending: opts.pipeline.approval?.pending() ?? [] });
        return;
      }
      const idMatch = /^\/([^/?]+)$/.exec(rest);
      if (method === "POST" && idMatch) {
        const body = (await readJsonBody(req)) as { approved?: unknown } | undefined;
        if (!body || typeof body.approved !== "boolean") {
          sendJson(res, 400, { error: "body must be { approved: boolean }" });
          return;
        }
        if (!opts.pipeline.approval) {
          sendJson(res, 404, { error: "no approval queue configured" });
          return;
        }
        // `by` is the AUTHENTICATED approver — never taken from the body.
        opts.pipeline.approval.resolve(idMatch[1], body.approved, approver);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (!routeIs(url, path)) {
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

    // 1b. Prove our identity: sign the client's DPoP proof with the gateway
    //     private key so the client can verify it against the pinned pubkey.
    //     Set before the SDK writes the response (writeHead merges setHeader).
    if (opts.gatewayPrivateKeyPem) {
      const proof = (req.headers as Record<string, string | undefined>).dpop;
      if (proof) res.setHeader(SERVER_AUTH_HEADER, signServerAuth(opts.gatewayPrivateKeyPem, proof));
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
