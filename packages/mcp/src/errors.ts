/** Thrown when a mandatory MCP server cannot be connected or enumerated. */
export class McpConnectionError extends Error {
  readonly serverName: string;
  constructor(serverName: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpConnectionError";
    this.serverName = serverName;
  }
}
