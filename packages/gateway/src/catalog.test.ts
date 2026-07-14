import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGateway } from "./server.ts";
import type { ToolSpec } from "./catalog.ts";

/** Connect an in-memory MCP client to a gateway serving `catalog` (no network). */
async function connect(catalog: ToolSpec[]) {
  const gw = createGateway({ catalog });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await gw.server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { gw, client };
}

test("tools/list serves exactly the pinned catalog (not a live upstream list)", async () => {
  const { gw, client } = await connect([
    { name: "github__list_issues", description: "List issues" },
    { name: "github__get_issue" },
  ]);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["github__list_issues", "github__get_issue"]);
    expect(tools[0].description).toBe("List issues");
    // Every tool carries an object input schema.
    expect(tools[1].inputSchema.type).toBe("object");
  } finally {
    await gw.close();
  }
});

test("a catalog tool call is refused until it's wired to an upstream (fail-closed)", async () => {
  const { gw, client } = await connect([{ name: "t" }]);
  try {
    const res = await client.callTool({ name: "t", arguments: {} });
    expect(res.isError).toBe(true);
  } finally {
    await gw.close();
  }
});

test("a call to a tool NOT in the catalog is refused", async () => {
  const { gw, client } = await connect([{ name: "known" }]);
  try {
    const res = await client.callTool({ name: "unknown", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("unknown tool");
  } finally {
    await gw.close();
  }
});
