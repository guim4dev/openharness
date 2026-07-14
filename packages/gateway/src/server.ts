import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeCatalog, type ToolCatalog, type ToolSpec } from "./catalog.ts";

/**
 * The remote MCP gateway, as an MCP **server** a harness connects to. v2's
 * "smallest defensible slice": serves a pinned virtual catalog and (in later
 * tasks) gates every `tools/call` through auth -> policy -> credential broker ->
 * a sandboxed connector, redacting the return path and appending an
 * authoritative audit record. The gateway holds its OWN per-upstream credential
 * and never forwards an inbound token.
 */
export interface GatewayOptions {
  /** The pinned virtual catalog served for `tools/list`. */
  catalog: ToolSpec[];
}

export interface Gateway {
  server: Server;
  close(): Promise<void>;
}

const SERVER_INFO = { name: "openharness-gateway", version: "0.0.1" };

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

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const name = req.params.name;
    // Fail-closed: a call to a tool not in the pinned catalog is refused.
    if (!catalog.some((t) => t.name === name)) {
      return { content: [{ type: "text" as const, text: `unknown tool: ${name}` }], isError: true };
    }
    // The governed pipeline (auth -> PDP -> broker -> connector -> redact ->
    // audit) is wired in later tasks; until then an in-catalog call is refused
    // rather than silently executed.
    return {
      content: [{ type: "text" as const, text: `tool '${name}' is not yet wired to an upstream` }],
      isError: true,
    };
  });

  return {
    server,
    async close() {
      await server.close();
    },
  };
}
