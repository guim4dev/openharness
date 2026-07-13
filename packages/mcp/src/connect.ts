import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec } from "@openharness/definition";
import type { McpCallToolResult, McpConnection, McpToolInfo } from "./types.ts";

const CLIENT_INFO = { name: "openharness", version: "0.0.1" };

/**
 * Connect to a single MCP server using the official SDK Client and the transport
 * selected by the spec:
 * - stdio: launch `command` (+ args/env) as a child process; env is merged onto
 *   the SDK's default environment so the child inherits PATH etc.
 * - http:  connect to `url` over streamable HTTP.
 *
 * The SDK runs the MCP `initialize` handshake inside `client.connect(...)`.
 */
export async function connectMcpServer(name: string, spec: McpServerSpec): Promise<McpConnection> {
  let transport: StdioClientTransport | StreamableHTTPClientTransport;

  if (spec.transport === "stdio") {
    if (!spec.command) throw new Error(`MCP server '${name}': stdio transport requires 'command'`);
    transport = new StdioClientTransport({
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
    });
  } else {
    if (!spec.url) throw new Error(`MCP server '${name}': http transport requires 'url'`);
    transport = new StreamableHTTPClientTransport(new URL(spec.url));
  }

  const client = new Client(CLIENT_INFO);
  await client.connect(transport);

  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools as unknown as McpToolInfo[];
    },
    async callTool(toolName, args) {
      const result = await client.callTool({ name: toolName, arguments: args });
      return result as unknown as McpCallToolResult;
    },
    async close() {
      await client.close();
    },
  };
}
