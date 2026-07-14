/**
 * The gateway's PINNED virtual tool catalog. What a connecting harness sees for
 * `tools/list` is served from HERE — hashed into the signed definition, never
 * proxied live from an upstream. This single decision kills rug-pull tool
 * poisoning at the client: a malicious upstream update can't change what a tool
 * appears to do, because the client never sees the upstream's live list.
 */
export interface ToolSpec {
  /** The `mcp__<server>__<tool>`-style name a harness calls and policy gates. */
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. Defaults to an open object. */
  inputSchema?: Record<string, unknown>;
}

export type ToolCatalog = ToolSpec[];

const EMPTY_SCHEMA: Record<string, unknown> = { type: "object", properties: {} };

/** Normalize a catalog: fill a default arg schema, drop unknown fields. */
export function normalizeCatalog(tools: ToolSpec[]): ToolCatalog {
  return tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema ?? EMPTY_SCHEMA,
  }));
}
