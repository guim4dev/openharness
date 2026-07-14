import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";

import {
  AuthProviderRegistry,
  CredentialManager,
  InMemorySecretStore,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";
import type { Policy } from "@openharness/policy";
import { verifyAuditLog } from "@openharness/audit";
import type { ConnectFn, McpConnection } from "@openharness/mcp";

import { createLiveSession } from "./live-session.ts";
import type { LiveSessionEvent } from "./live-session.ts";

/**
 * End-to-end composition proof for the OpenHarness governance chain.
 *
 * Each governance piece is unit-tested in isolation elsewhere:
 *   - packages/mcp        — bridges an in-memory MCP server into `mcp__<server>__<tool>`.
 *   - packages/policy     — deny/allow decisions + secret redaction.
 *   - packages/audit      — hash-chained, secret-free audit log.
 *
 * The RISK is that they don't COMPOSE inside a real `createLiveSession`. This
 * single live session drives all three together against one temp audit file:
 *
 *  (1) an in-memory MCP server's tool is bridged (present as `mcp__test__echo`);
 *  (2) a policy denying `mcp__test__*` BLOCKS that tool — its body never runs;
 *  (3) the audit file records that block as tool_call decision:"deny" for the
 *      bridged name, tagged with its server, with no raw secret in the file;
 *  (4) an allowed tool carrying a secret in its args AND result has that secret
 *      redacted before the tool sees it, before it re-enters model context, and
 *      before it is fingerprinted into the audit log.
 */

const SECRET = "sk-LIVE-deadBEEF0123";
const PLACEHOLDER = "sk-REDACTED";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oh-governance-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function buildCredentials() {
  const store = new InMemorySecretStore();
  const accounts: Account[] = [
    {
      id: "a",
      authProviderId: "api-key",
      label: "a",
      credential: { kind: "api_key", secretRef: "api-key:a" },
      health: { state: "ok" },
    },
  ];
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["a"] }];
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));
  return { store, manager, registry };
}

/** Write a minimal harness dir that DECLARES an MCP server named `test`. */
async function writeHarness(): Promise<string> {
  const dir = join(tmp, "harness");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "harness.json"),
    JSON.stringify({
      name: "governance",
      version: "0.0.0",
      branding: { displayName: "Governance" },
      systemPrompt: "system-prompt.md",
      skills: [],
      providers: {
        default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" },
      },
      // The connection factory is overridden with an in-memory server in the test,
      // so `command` is never actually spawned — it only satisfies the schema.
      mcp: { servers: { test: { transport: "stdio", command: "irrelevant" } } },
    }),
  );
  await writeFile(join(dir, "system-prompt.md"), "You are a test harness.");
  return dir;
}

/**
 * A deterministic in-memory MCP server exposing one `echo` tool, linked to a
 * client over InMemoryTransport (no sockets, no child process). Tracks how many
 * times its tool body actually executed, so the test can PROVE a policy deny
 * stops the call before it reaches the server.
 */
async function inMemoryConnection(): Promise<McpConnection & { echoCalls: () => number }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  let echoCalls = 0;
  const server = new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "echo back a message",
        inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    echoCalls++;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    return { content: [{ type: "text", text: `got:${String(args.msg)}` }] };
  });
  await server.connect(serverTransport);

  const client = new Client({ name: "harness-test", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools as never;
    },
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args })) as never;
    },
    async close() {
      await client.close();
      await server.close();
    },
    echoCalls: () => echoCalls,
  };
}

/** Records what the allowed custom tool actually observed at execution time. */
interface ToolRecord {
  calls: number;
  lastArgs: unknown;
  resultText: string;
}

/** An allowed (non-MCP) tool whose args AND result carry a secret. */
function makeSecretEchoTool(record: ToolRecord): ToolDefinition {
  return {
    name: "secret_echo",
    label: "secret_echo",
    description: "Echoes a token; its result text also carries the token.",
    parameters: {
      type: "object",
      properties: { token: { type: "string" } },
      required: [],
    } as unknown as ToolDefinition["parameters"],
    async execute(_toolCallId, params) {
      record.calls++;
      record.lastArgs = params;
      return { content: [{ type: "text", text: record.resultText }], details: undefined };
    },
  } as ToolDefinition;
}

/**
 * A four-step faux model driving ONE session across TWO turns:
 *   turn 1: call the bridged MCP tool `mcp__test__echo` with a secret arg (denied);
 *   turn 2: call the allowed `secret_echo` with a secret arg (allowed + redacted).
 * The final step inspects the post-tool context to prove the secret-bearing tool
 * RESULT was redacted before it re-entered the model's context.
 */
function fourStepModelRegistry(opts: {
  onFinalContext: (context: Context) => void;
}): (authStorage: AuthStorage) => ModelRegistry {
  return (authStorage) => {
    const registry = ModelRegistry.inMemory(authStorage);
    const core = createFauxCore({ provider: "anthropic", api: "anthropic-messages" });
    core.setResponses([
      // turn 1 — provider call 1: try the bridged MCP tool with a secret arg.
      fauxAssistantMessage([fauxToolCall("mcp__test__echo", { msg: SECRET })], {
        stopReason: "toolUse",
      }),
      // turn 1 — provider call 2: settle after the deny becomes an error result.
      fauxAssistantMessage("mcp attempt done", { stopReason: "stop" }),
      // turn 2 — provider call 3: call the allowed tool with a secret arg.
      fauxAssistantMessage([fauxToolCall("secret_echo", { token: SECRET })], {
        stopReason: "toolUse",
      }),
      // turn 2 — provider call 4: settle; inspect the context the tool result re-entered.
      (context) => {
        opts.onFinalContext(context);
        return fauxAssistantMessage("allowed tool done", { stopReason: "stop" });
      },
    ]);
    registry.registerProvider("anthropic", {
      baseUrl: "http://stub.local",
      apiKey: "stub-key",
      api: "anthropic-messages",
      streamSimple: core.streamSimple,
      models: [
        {
          id: "claude-sonnet-5",
          name: "claude-sonnet-5 (four-step stub)",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    });
    return registry;
  };
}

test("MCP bridge + policy deny + redaction + audit COMPOSE in one live session", async () => {
  const { store, manager, registry } = buildCredentials();
  await store.set("api-key:a", "key-a");

  const harnessPath = await writeHarness();
  const conn = await inMemoryConnection();
  const mcpConnect: ConnectFn = async () => conn;

  const auditPath = join(tmp, "audit", "session.jsonl");
  const record: ToolRecord = {
    calls: 0,
    lastArgs: undefined,
    resultText: `the allowed tool result leaks ${SECRET} in its text`,
  };

  // default:allow, but DENY every tool on the `test` MCP server + redact the secret.
  const policy: Policy = {
    default: "allow",
    rules: [
      { match: "mcp__test__*", action: "deny", reason: "MCP server 'test' is denied by policy." },
    ],
    redact: [{ pattern: "sk-LIVE-[A-Za-z0-9]+", replace: PLACEHOLDER }],
  };

  // Capture how the allowed tool's secret-bearing RESULT looks by the time it
  // has re-entered the model's context for the final provider call.
  let allowedResultInContext: string | undefined;
  const live = await createLiveSession({
    harnessPath,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    policy,
    auditPath,
    mcpConnect,
    customTools: [makeSecretEchoTool(record)],
    modelRegistryOverride: fourStepModelRegistry({
      onFinalContext: (context) => {
        const msgs = context.messages as unknown as Array<Record<string, unknown>>;
        const toolResult = msgs.find(
          (m) => m.role === "toolResult" && m.toolName === "secret_echo",
        );
        allowedResultInContext = toolResult ? JSON.stringify(toolResult) : undefined;
      },
    }),
  });

  // (1) The in-memory MCP server's tool is BRIDGED through createLiveSession's own
  // loadMcpTools path — present under the namespaced Pi name.
  const toolNames = live.session.getAllTools().map((t) => t.name);
  expect(toolNames).toContain("mcp__test__echo");
  expect(toolNames).toContain("secret_echo");

  const events: LiveSessionEvent[] = [];
  try {
    // Turn 1: model tries the denied MCP tool. Turn 2: model uses the allowed tool.
    await live.prompt("call the mcp tool", (e) => events.push(e));
    await live.prompt("now call the allowed tool", (e) => events.push(e));
  } finally {
    await live.close();
  }

  // (2) The policy BLOCKED the MCP tool: its body on the in-memory server never
  // ran, no run errored, and both turns still settled.
  expect(conn.echoCalls()).toBe(0);
  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events.filter((e) => e.type === "done")).toHaveLength(2);

  // (4a) Redaction happened BEFORE the allowed tool executed: it saw the
  // placeholder, never the raw secret.
  expect(record.calls).toBe(1);
  expect((record.lastArgs as { token?: string }).token).toBe(PLACEHOLDER);
  expect(JSON.stringify(record.lastArgs)).not.toContain("sk-LIVE-");

  // (4b) The secret-bearing tool RESULT was redacted before it re-entered the
  // model's context: by the final provider call, the `secret_echo` tool-result
  // message carries the placeholder, never the raw secret.
  // NOTE (composition finding, minor): arg-redaction only guarantees the secret
  // never reaches the TOOL (asserted above via record.lastArgs). It does NOT
  // scrub secrets the MODEL itself emitted in its tool-call arguments from the
  // transcript — those persist raw in the assistant message. That vector is
  // normally closed upstream (a model can only emit a secret it already holds,
  // and tool results are redacted before it could obtain one), so this is a
  // documented boundary, not a break in the deny/redact/audit chain under test.
  expect(allowedResultInContext).toBeDefined();
  expect(allowedResultInContext).toContain(PLACEHOLDER);
  expect(allowedResultInContext).not.toContain("sk-LIVE-");

  // Read the audit log the whole chain wrote.
  const content = await readFile(auditPath, "utf8");
  const lines = content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  // (3) The DENY of the bridged MCP tool is recorded: tool_call, decision:"deny",
  // tagged with the parsed MCP server + the winning rule, args fingerprinted.
  const deniedMcp = lines.find(
    (l) => l.type === "tool_call" && l.tool === "mcp__test__echo",
  );
  expect(deniedMcp).toBeDefined();
  expect(deniedMcp!.decision).toBe("deny");
  expect(deniedMcp!.server).toBe("test");
  expect(deniedMcp!.ruleId).toBe("mcp__test__*");
  expect(deniedMcp!.argsHash).toMatch(/^[0-9a-f]{64}$/);

  // The allowed tool call is recorded as allow; its secret-bearing result is
  // recorded as redacted, fingerprinted only.
  const allowedCall = lines.find((l) => l.type === "tool_call" && l.tool === "secret_echo");
  expect(allowedCall).toBeDefined();
  expect(allowedCall!.decision).toBe("allow");
  expect(allowedCall!.argsHash).toMatch(/^[0-9a-f]{64}$/);

  const allowedResult = lines.find((l) => l.type === "tool_result" && l.tool === "secret_echo");
  expect(allowedResult).toBeDefined();
  expect(allowedResult!.redacted).toBe(true);
  expect(allowedResult!.resultHash).toMatch(/^[0-9a-f]{64}$/);

  // (4c) Redaction happened BEFORE anything was fingerprinted: no raw secret and
  // no placeholder text leaked into the audit file — only irreversible hashes.
  expect(content).not.toContain("sk-LIVE-");
  expect(content).not.toContain(SECRET);
  expect(content).not.toContain(PLACEHOLDER);

  // The audit chain is intact and tamper-evident end to end.
  expect(verifyAuditLog(auditPath)).toEqual({ ok: true });
});
