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

/**
 * Whether an UNTRUSTED MCP server's tool name is safe to bridge. A server could
 * return a name with whitespace, control/RTL-override chars, or absurd length;
 * bridged verbatim it poisons the whole tool list (providers reject names
 * outside ~`[A-Za-z0-9_-]{1,128}`), taking the harness down, and RTL/homoglyphs
 * spoof the name in any UI. Callers skip a tool that fails this.
 */
export function isSafeMcpToolName(toolName: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(toolName);
}

/** Cap on a single bridged content block — an untrusted server must not flood the
 *  agent's context / amplify token cost / risk OOM with an unbounded blob. Applies
 *  to text/serialized blocks AND to an image block's base64 `data`. */
const MAX_RESULT_CHARS = 262_144; // 256 KiB per block

/** Cap on the AGGREGATE of one tool result across ALL its blocks. The per-block
 *  cap alone does not bound the total: a server can return an unbounded NUMBER of
 *  in-cap blocks and still flood context / OOM. Enforced by short-circuiting the
 *  block loop, so oversized results are never materialized in full. */
const MAX_TOTAL_RESULT_CHARS = MAX_RESULT_CHARS * 4; // 1 MiB across all blocks

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {}, required: [] } as const;

/** Truncate an untrusted string to a cap, marking it when cut. */
function capTo(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}\n…[truncated by openharness: content exceeded ${cap} chars]` : text;
}

/** Truncate an untrusted string block to the per-block result cap, marking it when cut. */
function capText(text: string): string {
  return capTo(text, MAX_RESULT_CHARS);
}

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
      // The result comes from an UNTRUSTED server: a missing/non-array `content`
      // must not crash the bridge with a raw TypeError.
      const blocks = Array.isArray(result.content) ? result.content : [];

      if (result.isError) {
        const text = blocks
          .filter((c) => c && c.type === "text")
          .map((c) => String((c as { text?: unknown }).text ?? ""))
          .join("\n");
        throw new Error(capText(text) || `MCP tool '${piName}' returned an error`);
      }

      const content: PiContent[] = [];
      // Enforce BOTH a per-block cap and an aggregate cap, short-circuiting so an
      // unbounded number (or size) of blocks from an untrusted server is never
      // materialized in full.
      let used = 0;
      for (const c of blocks) {
        const remaining = MAX_TOTAL_RESULT_CHARS - used;
        if (remaining <= 0) {
          content.push({
            type: "text",
            text: `…[truncated by openharness: result exceeded the ${MAX_TOTAL_RESULT_CHARS}-char aggregate budget; remaining blocks dropped]`,
          });
          break;
        }
        // Effective cap for this block: the per-block cap, further limited by the
        // aggregate budget still available.
        const cap = Math.min(MAX_RESULT_CHARS, remaining);

        if (c && c.type === "text") {
          const raw = String((c as { text?: unknown }).text ?? "");
          content.push({ type: "text", text: capTo(raw, cap) });
          used += Math.min(raw.length, cap);
        } else if (c && c.type === "image") {
          const img = c as { data?: unknown; mimeType?: unknown };
          const data = String(img.data ?? "");
          if (data.length > cap) {
            // A truncated base64 blob is a corrupt image that still costs the full
            // token budget — drop it for a tiny visible marker instead.
            content.push({
              type: "text",
              text: `…[image dropped by openharness: base64 data (${data.length} chars) exceeded the ${cap}-char budget]`,
            });
            used += cap;
          } else {
            content.push({
              type: "image",
              data,
              mimeType: String(img.mimeType ?? "application/octet-stream"),
            });
            used += data.length;
          }
        } else {
          // audio / embedded resource (or a malformed block): Pi has no matching
          // content type — stringify defensively (a circular block can't throw us).
          let text: string;
          try {
            text = JSON.stringify(c) ?? "";
          } catch {
            text = "[unserializable content block]";
          }
          content.push({ type: "text", text: capTo(text, cap) });
          used += Math.min(text.length, cap);
        }
      }

      return { content, details: undefined };
    },
  };

  return tool;
}
