import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpCallTool, McpToolInfo } from "./types.ts";

/** Pi's tool-result content blocks (structurally TextContent | ImageContent). */
type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** The Pi tool name for an MCP tool: `mcp__<server>__<tool>`. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {}, required: [] } as const;

/**
 * Bridge one MCP tool into a Pi `ToolDefinition`.
 *
 * - name: `mcp__<server>__<tool>` (namespaced so servers can't collide).
 * - parameters: the MCP `inputSchema` (plain JSON Schema) passed through verbatim.
 *   Pi treats `parameters` as JSON Schema end-to-end (serializes it to the provider
 *   and validates args via TypeBox's `Compile`), so we cast rather than rebuild it.
 *   Typed as `ToolDefinition["parameters"]` (= TypeBox `TSchema`) — no `typebox`
 *   import and no schema reconstruction.
 * - execute: forwards the validated args to `client.callTool`, maps MCP result
 *   content (text/image passthrough; audio/resource stringified) into Pi's
 *   `AgentToolResult`. An MCP `isError: true` is surfaced by THROWING, matching
 *   Pi's tool contract (errors are thrown, not encoded in content).
 */
export function mcpToolToPiTool(
  serverName: string,
  mcpTool: McpToolInfo,
  callTool: McpCallTool,
): ToolDefinition {
  const piName = mcpToolName(serverName, mcpTool.name);
  const schema = (mcpTool.inputSchema ?? EMPTY_OBJECT_SCHEMA) as ToolDefinition["parameters"];

  const tool: ToolDefinition = {
    name: piName,
    label: piName,
    description: mcpTool.description ?? `MCP tool '${mcpTool.name}' from server '${serverName}'`,
    parameters: schema,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const result = await callTool(mcpTool.name, args);

      if (result.isError) {
        const text = result.content
          .filter((c) => c.type === "text")
          .map((c) => String((c as { text?: unknown }).text ?? ""))
          .join("\n");
        throw new Error(text || `MCP tool '${piName}' returned an error`);
      }

      const content: PiContent[] = [];
      for (const c of result.content) {
        if (c.type === "text") {
          content.push({ type: "text", text: String((c as { text?: unknown }).text ?? "") });
        } else if (c.type === "image") {
          const img = c as { data?: unknown; mimeType?: unknown };
          content.push({
            type: "image",
            data: String(img.data ?? ""),
            mimeType: String(img.mimeType ?? "application/octet-stream"),
          });
        } else {
          // audio / embedded resource: Pi has no matching content type — stringify.
          content.push({ type: "text", text: JSON.stringify(c) });
        }
      }

      return { content, details: undefined };
    },
  };

  return tool;
}
