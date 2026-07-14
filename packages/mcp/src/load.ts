import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessDefinition } from "@openharness/definition";
import { mcpToolToPiTool } from "./bridge.ts";
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
    for (const mcpTool of mcpTools) {
      if (allow && !allow.includes(mcpTool.name)) continue;
      tools.push(mcpToolToPiTool(serverName, mcpTool, callTool));
    }
  }

  return { tools, dispose: disposeAll };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
