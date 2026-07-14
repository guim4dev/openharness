import type { UpstreamCredential } from "../broker.ts";
import type { ToolCatalog } from "../catalog.ts";

export interface ConnectorResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * A sandboxed adapter to ONE upstream. Given a resolved credential at call time
 * (never held on the connector), it makes egress-gated requests and returns a
 * result. First-party adapters call the upstream REST API directly — NOT a
 * third-party MCP npm wrapper, so there is no auto-updating middle layer to be
 * rug-pulled (the Postmark lesson). Each connector declares the `tools` it backs
 * (a subset of the gateway's pinned catalog) and the `allowHosts` it may reach.
 */
export interface Connector {
  id: string;
  tools: ToolCatalog;
  allowHosts: string[];
  call(toolName: string, args: Record<string, unknown>, cred: UpstreamCredential): Promise<ConnectorResult>;
}
