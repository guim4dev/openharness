import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuditSink } from "@openharness/audit";
import type { Policy } from "@openharness/policy";
import { normalizeCatalog, type ToolCatalog, type ToolSpec } from "./catalog.ts";
import { decide } from "./pdp.ts";
import { isDeny, type Deny, type Principal } from "./auth.ts";
import type { KmsStore } from "./broker.ts";
import type { ConnectorSessions } from "./sessions.ts";
import type { ApprovalQueue } from "./approval.ts";
import { sanitizeResult } from "./redact-return.ts";
import { auditGovernedCall } from "./audit-endpoint.ts";

/** Classify a connector's thrown error for pool rotation/backoff. */
function classifyUpstreamError(message: string): "rate_limit" | "auth" | "other" {
  const m = message.toLowerCase();
  if (/\b429\b|rate.?limit|too many requests/.test(m)) return "rate_limit";
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid.?(token|credential|api.?key|secret)/.test(m)) return "auth";
  return "other";
}

/**
 * The governed execution pipeline. When present, every `tools/call` flows
 * auth -> PDP (authoritative) -> allow/ask/deny -> credential broker (post-
 * decision) -> per-user connector -> return-path redaction -> authoritative
 * audit. When ABSENT, `tools/call` is fail-closed (catalog served, calls refused).
 */
export interface GatewayPipeline {
  policy: Policy;
  policyVersion: string;
  /** Auth seam: resolve the caller from request context. Prod validates a
   *  DPoP-bound token off the HTTP headers; tests inject a principal. */
  resolvePrincipal: (extra: unknown) => Principal | Deny;
  broker: KmsStore;
  sessions: ConnectorSessions;
  audit: AuditSink;
  approval: ApprovalQueue;
}

export interface GatewayOptions {
  catalog: ToolSpec[];
  pipeline?: GatewayPipeline;
}

export interface Gateway {
  server: Server;
  close(): Promise<void>;
}

const SERVER_INFO = { name: "openharness-gateway", version: "0.0.1" };
const err = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

function summarize(redactedArgs: unknown): string {
  const s = JSON.stringify(redactedArgs ?? {});
  return s.length > 2_000 ? `${s.slice(0, 2_000)}…` : s;
}

export function createGateway(opts: GatewayOptions): Gateway {
  const catalog: ToolCatalog = normalizeCatalog(opts.catalog);
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: catalog.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as {
        type: "object";
        [k: string]: unknown;
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const entry = catalog.find((t) => t.name === name);
    if (!entry) return err(`unknown tool: ${name}`);

    const p = opts.pipeline;
    if (!p) return err(`tool '${name}' is not yet wired to an upstream`); // fail-closed

    // 1. AuthN — resolve + verify the caller (DPoP-bound in prod).
    const principal = p.resolvePrincipal(extra);
    if (isDeny(principal)) return err("unauthorized");

    // 2. PDP — the authoritative decision, before any credential is touched.
    const evalr = decide(p.policy, principal, name, args);
    const base = {
      principal: principal.sub,
      policyVersion: p.policyVersion,
      tool: name,
      redactedArgs: evalr.redactedArgs,
    };

    if (evalr.decision === "deny") {
      await auditGovernedCall(p.audit, { ...base, decision: "deny" });
      return err(evalr.reason ?? "blocked by policy");
    }

    if (evalr.decision === "ask") {
      const approved = await p.approval.request({
        principal: principal.sub,
        tool: name,
        argsSummary: summarize(evalr.redactedArgs),
      });
      if (!approved) {
        await auditGovernedCall(p.audit, { ...base, decision: "ask-denied" });
        return err("not approved");
      }
    }

    // 3. allow (or ask-approved): resolve the org credential AFTER the decision,
    //    hand it to a per-user connector, redact the return, and audit.
    const connectorId = entry.connectorId;
    if (!connectorId) return err(`tool '${name}' has no connector configured`);
    const upstreamId = entry.upstreamId ?? connectorId;
    const cred = await p.broker.resolve(upstreamId);
    if (!cred) return err(`no credential configured for upstream '${upstreamId}'`);

    let result;
    try {
      const connector = p.sessions.for(principal.sub, connectorId);
      result = await connector.call(name, args, cred); // ORIGINAL args reach the upstream
      // A pooled broker rotates on reported failures — a clean call keeps the
      // used credential healthy. (No-op for a single-credential broker.)
      p.broker.report?.(upstreamId, cred.credentialId, { ok: true });
    } catch (e) {
      const message = (e as Error)?.message ?? "upstream error";
      // A THROW from a connector is an unambiguous call failure — classify it so
      // the pool backs off (rate limit) or invalidates (auth) the credential and
      // the next call rotates to a healthy one. Connectors should THROW on an
      // upstream auth/rate-limit rejection (not swallow it into an isError) to
      // trigger rotation.
      p.broker.report?.(upstreamId, cred.credentialId, { ok: false, kind: classifyUpstreamError(message) });
      return err(message);
    }

    const sanitized = sanitizeResult(p.policy, {
      content: result.content,
      ...(result.isError ? { isError: result.isError } : {}),
    });
    await auditGovernedCall(p.audit, {
      ...base,
      decision: evalr.decision === "ask" ? "ask-approved" : "allow",
      result: sanitized.content,
    });
    return { content: sanitized.content, ...(sanitized.isError ? { isError: true } : {}) } as CallToolResult;
  });

  return {
    server,
    async close() {
      await server.close();
    },
  };
}
