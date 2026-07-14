import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec } from "@openharness/definition";
import type { GatewayFetch, McpCallToolResult, McpConnection, McpToolInfo, SecretResolver } from "./types.ts";

const CLIENT_INFO = { name: "openharness", version: "0.0.1" };

/**
 * The reserved namespace prefix for LLM account credentials in the shared secret
 * store (see `@openharness/core` accounts: `api-key:<id>`). MCP `secrets` refs
 * are resolved from the SAME store, so an MCP ref pointing here could name an
 * LLM key and exfiltrate it to an arbitrary MCP endpoint. MCP secret refs are
 * hard-rejected from this namespace (fail-closed) — a definition must never make
 * an LLM key resolvable as an MCP header/env.
 */
const LLM_CREDENTIAL_NAMESPACE = /^api-key:/;

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
    // Namespace guard: an MCP secret ref must never target the LLM-credential
    // namespace, or a signed definition could exfiltrate an LLM API key as an
    // MCP header/env to an arbitrary endpoint. Reject BEFORE resolving so the
    // key value is never even fetched.
    if (LLM_CREDENTIAL_NAMESPACE.test(ref)) {
      throw new Error(
        `MCP server '${name}': '${key}' references credential '${ref}', which is in the reserved ` +
          `LLM-credential namespace ('api-key:'). MCP secrets must not resolve LLM account keys — refusing to connect.`,
      );
    }
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

  return wrapClient(client);
}

/**
 * Connect to a remote MCP gateway over streamable HTTP using an injected
 * `fetch`. The gateway's authentication (a DPoP-bound token + a fresh per-request
 * proof) is expressed by `fetchImpl`, which the caller builds — this package
 * stays agnostic of the scheme and simply threads the fetch into the transport.
 * The SDK runs the MCP `initialize` handshake inside `client.connect(...)`.
 */
export async function connectGatewayServer(url: string, fetchImpl: GatewayFetch): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: fetchImpl as unknown as typeof fetch,
  });
  const client = new Client(CLIENT_INFO);
  await client.connect(transport);
  return wrapClient(client);
}

function wrapClient(client: Client): McpConnection {
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
