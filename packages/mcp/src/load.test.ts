import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { HarnessDefinition, McpServerSpec } from "@openharness/definition";
import { loadMcpTools } from "./load.ts";
import { McpConnectionError } from "./errors.ts";
import type { ConnectFn, McpConnection, McpToolInfo } from "./types.ts";

/** A HarnessDefinition carrying only the mcp servers under test. */
function defWithMcp(servers: Record<string, McpServerSpec>): HarnessDefinition {
  return {
    manifest: {
      name: "t",
      version: "0.0.0",
      branding: { displayName: "T" },
      systemPrompt: "system-prompt.md",
      skills: [],
      providers: { default: { provider: "anthropic", model: "m", credentialProfile: "work" } },
      mcp: { servers },
    },
    rootDir: "/nowhere",
    systemPromptText: "x",
    skillDirs: [],
  };
}

/**
 * A deterministic in-memory MCP server (echo + noop) linked to a client over
 * InMemoryTransport — no sockets, no child process. Uses the low-level `Server`
 * with plain-JSON request handlers so the test carries no zod schemas of its own
 * (the server's `inputSchema` is emitted as plain JSON Schema, exactly the MCP
 * wire shape the bridge consumes). Returned as an McpConnection.
 */
async function inMemoryConnection(): Promise<McpConnection & { serverClosed: () => boolean }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "echo back",
        inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      },
      { name: "noop", description: "does nothing", inputSchema: { type: "object", properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (req.params.name === "echo") {
      return { content: [{ type: "text", text: `got:${String(args.msg)}` }] };
    }
    return { content: [{ type: "text", text: "noop" }] };
  });
  await server.connect(serverTransport);

  const client = new Client({ name: "harness-test", version: "0.0.0" });
  await client.connect(clientTransport);

  let closed = false;
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools as never;
    },
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args })) as never;
    },
    async close() {
      closed = true;
      await client.close();
      await server.close();
    },
    serverClosed: () => closed,
  };
}

async function invoke(tool: { execute: (...a: never[]) => unknown }, args: unknown) {
  const exec = tool.execute as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  return exec("call-1", args, undefined, undefined, undefined);
}

test("loadMcpTools bridges an in-memory server's tools into namespaced Pi tools and round-trips execute", async () => {
  const conn = await inMemoryConnection();
  const connect: ConnectFn = async () => conn;

  const { tools, dispose } = await loadMcpTools(
    defWithMcp({ test: { transport: "stdio", command: "irrelevant" } }),
    { connect },
  );

  try {
    const names = tools.map((t) => t.name);
    expect(names).toContain("mcp__test__echo");
    expect(names).toContain("mcp__test__noop");

    const echo = tools.find((t) => t.name === "mcp__test__echo")!;
    expect(echo.description).toBe("echo back");

    const result = await invoke(echo, { msg: "hello" });
    expect(result.content).toEqual([{ type: "text", text: "got:hello" }]);
  } finally {
    await dispose();
  }

  expect(conn.serverClosed()).toBe(true);
});

test("a per-server tool allowlist filters which tools are bridged", async () => {
  const conn = await inMemoryConnection();
  const connect: ConnectFn = async () => conn;

  const { tools, dispose } = await loadMcpTools(
    defWithMcp({ test: { transport: "stdio", command: "irrelevant", tools: ["echo"] } }),
    { connect },
  );

  try {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["mcp__test__echo"]);
    expect(names).not.toContain("mcp__test__noop");
  } finally {
    await dispose();
  }
});

test("a mandatory server that cannot connect makes loadMcpTools throw", async () => {
  const connect: ConnectFn = async (name) => {
    throw new Error(`boom connecting to ${name}`);
  };

  await expect(
    loadMcpTools(defWithMcp({ test: { transport: "stdio", command: "x", mandatory: true } }), { connect }),
  ).rejects.toBeInstanceOf(McpConnectionError);

  await expect(
    loadMcpTools(defWithMcp({ test: { transport: "stdio", command: "x", mandatory: true } }), { connect }),
  ).rejects.toThrow(/failed to connect/);
});

test("a non-mandatory server that cannot connect is logged and skipped, others still load", async () => {
  const good = await inMemoryConnection();
  const warnings: string[] = [];
  const connect: ConnectFn = async (name) => {
    if (name === "bad") throw new Error("nope");
    return good;
  };

  const { tools, dispose } = await loadMcpTools(
    defWithMcp({
      bad: { transport: "stdio", command: "x" },
      test: { transport: "stdio", command: "y" },
    }),
    { connect, logger: (m) => warnings.push(m) },
  );

  try {
    expect(tools.map((t) => t.name)).toContain("mcp__test__echo");
    expect(warnings.some((w) => w.includes("bad") && w.includes("skipping"))).toBe(true);
  } finally {
    await dispose();
  }
});

test("loadMcpTools threads a secret resolver to connect, resolving refs from the provided store", async () => {
  const conn = await inMemoryConnection();
  const store = new Map<string, string>([["acme-analytics-ro", "resolved-secret-value"]]);

  // A ConnectFn that behaves like the real connector: it resolves each declared
  // secret ref through the injected resolver before "opening" the transport.
  let seen: Record<string, string> | undefined;
  const connect: ConnectFn = async (_name, spec, resolveSecret) => {
    seen = {};
    for (const [envVar, ref] of Object.entries(spec.secrets ?? {})) {
      const value = resolveSecret ? await resolveSecret(ref) : undefined;
      if (value === undefined) throw new Error(`unresolved ref ${ref}`);
      seen[envVar] = value;
    }
    return conn;
  };

  const { tools, dispose } = await loadMcpTools(
    defWithMcp({ test: { transport: "stdio", command: "irrelevant", secrets: { PGPASSWORD: "acme-analytics-ro" } } }),
    { connect, resolveSecret: (ref) => Promise.resolve(store.get(ref)) },
  );

  try {
    expect(tools.map((t) => t.name)).toContain("mcp__test__echo");
    // The ref resolved to the store's value and reached the connector as the env value.
    expect(seen).toEqual({ PGPASSWORD: "resolved-secret-value" });
  } finally {
    await dispose();
  }
});

test("finding 3: an untrusted server's tool list is deduped by name and capped in count", async () => {
  // Cap enforced by load.ts (kept in sync with MAX_TOOLS_PER_SERVER there).
  const MAX_TOOLS_PER_SERVER = 256;
  const many: McpToolInfo[] = Array.from({ length: 300 }, (_, i) => ({ name: `tool_${i}` }));
  const listed: McpToolInfo[] = [{ name: "dup" }, { name: "dup" }, ...many]; // 301 unique names + 1 dup

  const fakeConn: McpConnection = {
    async listTools() {
      return listed;
    },
    async callTool() {
      return { content: [] };
    },
    async close() {},
  };

  const warnings: string[] = [];
  const { tools, dispose } = await loadMcpTools(
    defWithMcp({ srv: { transport: "stdio", command: "x" } }),
    { connect: async () => fakeConn, logger: (m) => warnings.push(m) },
  );

  try {
    // Dedup: the duplicate name is bridged exactly once (first wins).
    expect(tools.filter((t) => t.name === "mcp__srv__dup")).toHaveLength(1);
    // Count cap: the over-long list is truncated to the per-server cap.
    expect(tools.length).toBe(MAX_TOOLS_PER_SERVER);
    // Both defenses are logged.
    expect(warnings.some((w) => /duplicate/i.test(w))).toBe(true);
    expect(warnings.some((w) => /cap|truncat/i.test(w))).toBe(true);
  } finally {
    await dispose();
  }
});

test("no mcp section yields no tools and a no-op dispose (backward compatible)", async () => {
  const def: HarnessDefinition = {
    manifest: {
      name: "t",
      version: "0.0.0",
      branding: { displayName: "T" },
      systemPrompt: "system-prompt.md",
      skills: [],
      providers: { default: { provider: "anthropic", model: "m", credentialProfile: "work" } },
    },
    rootDir: "/nowhere",
    systemPromptText: "x",
    skillDirs: [],
  };

  const { tools, dispose } = await loadMcpTools(def);
  expect(tools).toEqual([]);
  await expect(dispose()).resolves.toBeUndefined();
});
