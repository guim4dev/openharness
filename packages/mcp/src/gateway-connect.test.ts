import { afterEach, expect, test } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectGatewayServer } from "./connect.ts";
import type { GatewayFetch } from "./types.ts";

/**
 * A minimal stateless MCP HTTP server (SDK only, no gateway package — mcp cannot
 * depend on gateway without a cycle). Proves `connectGatewayServer` connects over
 * HTTP with an INJECTED fetch and bridges list/call. The full DPoP→governed
 * pipeline e2e lives in `@openharness/core` (which may depend on gateway).
 */
function makeMcpServer(): Server {
  const server = new Server({ name: "test-remote", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: "echo", description: "echoes msg", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text", text: `echo:${(req.params.arguments as { msg?: string })?.msg ?? ""}` }],
  }));
  return server;
}

let http: HttpServer | undefined;
afterEach(() => {
  http?.close();
  http = undefined;
});

async function startHttp(): Promise<string> {
  http = createServer((req, res) => {
    const server = makeMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", () => resolve()));
  const addr = http!.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}/mcp`;
}

test("connectGatewayServer connects with an injected fetch and bridges list/call", async () => {
  const url = await startHttp();
  let sawInjectedFetch = false;
  const fetchImpl: GatewayFetch = (input, init) => {
    sawInjectedFetch = true;
    return (fetch as unknown as GatewayFetch)(input, init);
  };

  const conn = await connectGatewayServer(url, fetchImpl);
  try {
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");

    const result = await conn.callTool("echo", { msg: "hi" });
    expect(JSON.stringify(result.content)).toContain("echo:hi");

    // The injected fetch was actually used for the transport's requests.
    expect(sawInjectedFetch).toBe(true);
  } finally {
    await conn.close();
  }
});
