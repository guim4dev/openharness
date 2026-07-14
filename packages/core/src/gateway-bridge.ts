import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessGatewayConfig } from "@openharness/definition";
import { createDpopFetch } from "@openharness/gateway";
import { connectGatewayServer, mcpToolToPiTool } from "@openharness/mcp";
import type { GatewayFetch, McpConnection } from "@openharness/mcp";

/**
 * Auth material the harness presents to the gateway: a short-lived, DPoP-bound
 * access token plus the client keypair that signs a fresh proof per request.
 * Obtaining it (the org IdP / token-exchange flow) is a deployment concern; this
 * is the material once obtained.
 */
export interface GatewayAuth {
  token: string;
  clientPublicKey: string;
  clientPrivateKey: string;
}

export interface LoadGatewayToolsOptions {
  /** Bridged tool namespace: `mcp__<namespace>__<tool>`. Default "gateway". */
  namespace?: string;
  /** Test seam: override the connection (defaults to a DPoP HTTP connection). */
  connect?: (url: string, fetchImpl: GatewayFetch) => Promise<McpConnection>;
}

export interface LoadGatewayToolsResult {
  tools: ToolDefinition[];
  /** Closes the gateway connection. Safe to call more than once. */
  dispose: () => Promise<void>;
}

/**
 * Connect to a declared remote gateway with a DPoP-bound token and bridge its
 * tools into Pi `ToolDefinition`s as `mcp__<namespace>__<tool>` — so the agent
 * calls a governed remote tool exactly like a local MCP tool, and it still flows
 * through the SAME local policy/audit path (defense in depth on top of the
 * gateway's authoritative server-side PDP).
 *
 * `gateway.tools` is the pinned catalog from the signed definition: when
 * non-empty it narrows what is bridged (a tool the gateway serves but the
 * harness did not pin is dropped); when empty, the gateway's own served catalog
 * is taken as-is (the gateway pins authoritatively server-side).
 *
 * Fail-closed: a declared gateway is mandatory. If the connection or tool
 * enumeration fails this THROWS (offline hard-fail) rather than silently dropping
 * the tools — a harness that declares a gateway must not run without it.
 */
export async function loadGatewayTools(
  gateway: HarnessGatewayConfig,
  auth: GatewayAuth,
  options: LoadGatewayToolsOptions = {},
): Promise<LoadGatewayToolsResult> {
  const namespace = options.namespace ?? "gateway";
  const connect = options.connect ?? connectGatewayServer;
  // Refuse to send credentials over plaintext to a non-loopback host — TLS is
  // what keeps a network observer from reading the token + proof at all.
  requireSecureUrl(gateway.url);
  // Pin the server identity: the fetch verifies every response is signed by the
  // private key matching the definition's pinned `pubkey`, so a fake gateway is
  // refused (see createDpopFetch / signServerAuth).
  const fetchImpl = createDpopFetch(
    auth.token,
    auth.clientPrivateKey,
    auth.clientPublicKey,
    undefined,
    undefined,
    gateway.pubkey,
  ) as GatewayFetch;

  let conn: McpConnection;
  try {
    conn = await connect(gateway.url, fetchImpl);
  } catch (err) {
    throw new Error(`gateway '${gateway.url}' failed to connect: ${errText(err)}`);
  }

  let mcpTools;
  try {
    mcpTools = await conn.listTools();
  } catch (err) {
    await conn.close().catch(() => {});
    throw new Error(`gateway '${gateway.url}' connected but listing tools failed: ${errText(err)}`);
  }

  const allow = gateway.tools;
  const callTool = conn.callTool.bind(conn);
  const tools: ToolDefinition[] = [];
  for (const mcpTool of mcpTools) {
    if (allow.length > 0 && !allow.includes(mcpTool.name)) continue;
    tools.push(mcpToolToPiTool(namespace, mcpTool, callTool));
  }

  return { tools, dispose: () => conn.close() };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A non-loopback gateway must be reached over https (credentials on the wire). */
function requireSecureUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`gateway url '${url}' is not a valid URL`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (u.protocol !== "https:" && !loopback) {
    throw new Error(
      `gateway url '${url}' must use https — refusing to send credentials over an unencrypted channel (plaintext is allowed only for loopback dev/test).`,
    );
  }
}
