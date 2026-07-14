import type { McpServerSpec } from "@openharness/definition";

/**
 * The subset of an MCP tool descriptor the bridge needs. `inputSchema` is plain
 * JSON Schema (MCP's on-the-wire shape) — Pi consumes it verbatim, so we do NOT
 * rebuild it in TypeBox.
 */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

/** A single content block of an MCP tool result (text | image | audio | resource ...). */
export interface McpContentBlock {
  type: string;
  [k: string]: unknown;
}

/** The MCP `CallToolResult`, narrowed to what the bridge reads. */
export interface McpCallToolResult {
  content: McpContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

/** Invokes one tool on a connected MCP server. */
export type McpCallTool = (toolName: string, args: Record<string, unknown>) => Promise<McpCallToolResult>;

/** A live connection to one MCP server, transport-agnostic. */
export interface McpConnection {
  listTools(): Promise<McpToolInfo[]>;
  callTool: McpCallTool;
  close(): Promise<void>;
}

/**
 * Resolves a credential REF name to its secret value from the machine-local
 * store, or `undefined` when the store holds no such ref. Structurally the same
 * shape as `SecretStore.get`, so a store can be adapted with `store.get.bind(store)`
 * — keeping this package decoupled from `@openharness/credentials`.
 */
export type SecretResolver = (ref: string) => Promise<string | undefined>;

/**
 * Establishes a connection to an MCP server from its spec. Overridable in tests.
 * `resolveSecret` resolves the spec's `secrets` refs (env-var/header name ->
 * credential ref) at connect time; a declared ref that cannot be resolved must
 * fail the connection (fail-closed) rather than connect with a blank secret.
 */
export type ConnectFn = (
  name: string,
  spec: McpServerSpec,
  resolveSecret?: SecretResolver,
) => Promise<McpConnection>;
