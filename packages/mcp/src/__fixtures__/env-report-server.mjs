// A minimal real stdio MCP server used by connect.test.ts to prove that a
// resolved secret actually lands in the spawned child process's ENVIRONMENT.
// Its single tool, `report_env`, echoes back the value of the requested env var
// — so the test can assert the credential the SecretStore resolved reached the
// transport, not just that the code path ran.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "env-report", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "report_env",
      description: "Report the value of a named environment variable.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String((req.params.arguments ?? {}).name ?? "");
  return { content: [{ type: "text", text: process.env[name] ?? "" }] };
});

await server.connect(new StdioServerTransport());
