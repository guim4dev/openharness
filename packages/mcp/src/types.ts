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

/** Establishes a connection to an MCP server from its spec. Overridable in tests. */
export type ConnectFn = (name: string, spec: McpServerSpec) => Promise<McpConnection>;
