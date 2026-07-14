import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec } from "@openharness/definition";
import type { McpCallToolResult, McpConnection, McpToolInfo, SecretResolver } from "./types.ts";

const CLIENT_INFO = { name: "openharness", version: "0.0.1" };

/**
 * Resolve a spec's `secrets` (env-var/header NAME -> credential REF name) to a
 * flat NAME -> value map via `resolveSecret`. Fail-closed: a declared ref throws
 * if no resolver is available or the store holds no (non-empty) value for it, so
 * we never connect with a blank secret. Runs BEFORE any transport is built.
 */
async function resolveSecrets(
  name: string,
  spec: McpServerSpec,
  resolveSecret?: SecretResolver,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const secrets = spec.secrets;
  if (!secrets || Object.keys(secrets).length === 0) return out;

  for (const [key, ref] of Object.entries(secrets)) {
    if (!resolveSecret) {
      throw new Error(
        `MCP server '${name}': '${key}' references credential '${ref}' but no secret store is available to resolve it`,
      );
    }
    const value = await resolveSecret(ref);
    if (value === undefined || value === "") {
      throw new Error(
        `MCP server '${name}': credential ref '${ref}' (for '${key}') is not present in the secret store — refusing to connect with a blank secret`,
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Connect to a single MCP server using the official SDK Client and the transport
 * selected by the spec:
 * - stdio: launch `command` (+ args/env) as a child process; env is merged onto
 *   the SDK's default environment so the child inherits PATH etc. Resolved
 *   `secrets` are merged LAST (over literal `env`) as env vars.
 * - http:  connect to `url` over streamable HTTP; literal `headers` plus resolved
 *   `secrets` (as headers, winning over literals) are sent on every request.
 *
 * Secrets are resolved through `resolveSecret` first and fail-closed: a declared
 * ref that cannot be resolved throws before the transport opens.
 *
 * The SDK runs the MCP `initialize` handshake inside `client.connect(...)`.
 */
export async function connectMcpServer(
  name: string,
  spec: McpServerSpec,
  resolveSecret?: SecretResolver,
): Promise<McpConnection> {
  const resolvedSecrets = await resolveSecrets(name, spec, resolveSecret);

  let transport: StdioClientTransport | StreamableHTTPClientTransport;

  if (spec.transport === "stdio") {
    if (!spec.command) throw new Error(`MCP server '${name}': stdio transport requires 'command'`);
    transport = new StdioClientTransport({
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      // Resolved secrets win over literal `env` of the same name.
      env: { ...getDefaultEnvironment(), ...(spec.env ?? {}), ...resolvedSecrets },
    });
  } else {
    if (!spec.url) throw new Error(`MCP server '${name}': http transport requires 'url'`);
    // Literal headers plus resolved secret headers (secrets win over literals).
    const headers = { ...(spec.headers ?? {}), ...resolvedSecrets };
    transport = new StreamableHTTPClientTransport(
      new URL(spec.url),
      Object.keys(headers).length > 0 ? { requestInit: { headers } } : {},
    );
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
