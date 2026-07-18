import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessDefinition } from "@openharness/definition";
import { isSafeMcpToolName, mcpToolToPiTool } from "./bridge.ts";
import { connectMcpServer } from "./connect.ts";
import { McpConnectionError } from "./errors.ts";
import type { ConnectFn, McpConnection, SecretResolver } from "./types.ts";

export interface LoadMcpToolsOptions {
  /** Override the connection factory (tests inject an in-memory connection). */
  connect?: ConnectFn;
  /** Where non-fatal warnings go. Default: console.warn. */
  logger?: (message: string) => void;
  /**
   * Resolves a server's `secrets` refs (env-var/header name -> credential ref)
   * to values at connect time, from the machine-local store. Forwarded to
   * `connect`; a spec that declares `secrets` with no resolver (or an
   * unresolvable ref) fails the connection (fail-closed).
   */
  resolveSecret?: SecretResolver;
}

/**
 * Cap on how many tools a SINGLE (untrusted) server may contribute. An arbitrarily
 * long tool list bridged verbatim floods the provider's tool list (token cost,
 * 400s) — cap it and log the truncation. Kept modest but well above any realistic
 * server's tool count.
 */
export const MAX_TOOLS_PER_SERVER = 256;

export interface LoadMcpToolsResult {
  tools: ToolDefinition[];
  /** Closes every open MCP connection. Safe to call more than once. */
  dispose: () => Promise<void>;
}

/**
 * Connect every MCP server declared on the harness, bridge each server's tools
 * (filtered by its optional allowlist) into Pi `ToolDefinition`s, and return them
 * plus a `dispose` that closes all connections.
 *
 * Failure policy:
 * - A `mandatory` server that fails to connect or enumerate throws
 *   `McpConnectionError` (fail fast); any already-open connections are closed first.
 * - A non-mandatory failure is logged and skipped.
 */
export async function loadMcpTools(
  definition: HarnessDefinition,
  options: LoadMcpToolsOptions = {},
): Promise<LoadMcpToolsResult> {
  const connect = options.connect ?? connectMcpServer;
  const log = options.logger ?? ((m: string) => console.warn(m));

  const connections: McpConnection[] = [];
  const tools: ToolDefinition[] = [];

  const disposeAll = async () => {
    await Promise.allSettled(connections.map((c) => c.close()));
    connections.length = 0;
  };

  const servers = definition.manifest.mcp?.servers;
  if (!servers || Object.keys(servers).length === 0) {
    return { tools, dispose: disposeAll };
  }

  for (const [serverName, spec] of Object.entries(servers)) {
    let conn: McpConnection;
    try {
      conn = await connect(serverName, spec, options.resolveSecret);
    } catch (err) {
      const message = `MCP server '${serverName}' failed to connect: ${errText(err)}`;
      if (spec.mandatory) {
        await disposeAll();
        throw new McpConnectionError(serverName, message, { cause: err });
      }
      log(`[openharness/mcp] ${message} — skipping (non-mandatory).`);
      continue;
    }
    connections.push(conn);

    let mcpTools;
    try {
      mcpTools = await conn.listTools();
    } catch (err) {
      const message = `MCP server '${serverName}' connected but listing tools failed: ${errText(err)}`;
      if (spec.mandatory) {
        await disposeAll();
        throw new McpConnectionError(serverName, message, { cause: err });
      }
      log(`[openharness/mcp] ${message} — skipping (non-mandatory).`);
      continue;
    }

    const allow = spec.tools;
    const callTool = conn.callTool.bind(conn);
    const seen = new Set<string>();
    let bridged = 0;
    let capped = false;
    for (const mcpTool of mcpTools) {
      if (allow && !allow.includes(mcpTool.name)) continue;
      // An untrusted server could return a tool name with whitespace, control/
      // RTL chars, or absurd length; bridged verbatim it poisons the ENTIRE tool
      // list the provider sees (400s → harness unusable) and spoofs UIs. Skip it.
      if (!isSafeMcpToolName(mcpTool.name)) {
        log(
          `[openharness/mcp] server '${serverName}' offered a tool with an unsafe name (${JSON.stringify(mcpTool.name)}) — skipping it.`,
        );
        continue;
      }
      // Dedup by name (first wins): a duplicate would bridge to an identical
      // `mcp__<server>__<name>` Pi tool, colliding in the provider's tool list.
      if (seen.has(mcpTool.name)) {
        log(
          `[openharness/mcp] server '${serverName}' offered a duplicate tool name (${JSON.stringify(mcpTool.name)}) — skipping the repeat.`,
        );
        continue;
      }
      // Cap how many tools one server may contribute (an over-long list floods the
      // provider's tool list). Log once and stop bridging further tools.
      if (bridged >= MAX_TOOLS_PER_SERVER) {
        capped = true;
        break;
      }
      seen.add(mcpTool.name);
      tools.push(mcpToolToPiTool(serverName, mcpTool, callTool));
      bridged++;
    }
    if (capped) {
      log(
        `[openharness/mcp] server '${serverName}' offered more tools than the per-server cap (${MAX_TOOLS_PER_SERVER}) — truncated the extra tools.`,
      );
    }
  }

  return { tools, dispose: disposeAll };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
