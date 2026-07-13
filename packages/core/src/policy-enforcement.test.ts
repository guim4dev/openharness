import { afterEach, beforeEach, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import {
  InMemorySecretStore,
  CredentialManager,
  AuthProviderRegistry,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";
import type { Policy } from "@openharness/policy";
import { createLiveSession } from "./live-session.ts";
import type { LiveSessionEvent } from "./live-session.ts";
import { createToolCallingStubModelRegistry } from "./testing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleHarness = join(here, "..", "..", "..", "harnesses", "example");

const LIVE_SECRET = "sk-LIVE-deadBEEF0123";
const PLACEHOLDER = "sk-REDACTED";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oh-policy-"));
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

interface ToolRecord {
  calls: number;
  lastArgs: unknown;
  resultText: string;
}

function makeStubTool(record: ToolRecord): ToolDefinition {
  return {
    name: "secret_echo",
    label: "secret_echo",
    description: "Echoes a token back, and returns some text in its result.",
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

async function runTurn(opts: {
  policy: Policy;
  tool: ToolDefinition;
  toolArgs: Record<string, unknown>;
  onSecondTurnContext?: (context: Context) => void;
}): Promise<LiveSessionEvent[]> {
  const { store, manager, registry } = buildCredentials();
  await store.set("api-key:a", "key-a");

  const live = await createLiveSession({
    harnessPath: exampleHarness,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    policy: opts.policy,
    customTools: [opts.tool],
    modelRegistryOverride: createToolCallingStubModelRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      toolName: "secret_echo",
      toolArgs: opts.toolArgs,
      finalReply: "all done",
      ...(opts.onSecondTurnContext ? { onSecondTurnContext: opts.onSecondTurnContext } : {}),
    }),
  });

  try {
    const events: LiveSessionEvent[] = [];
    await live.prompt("please call the tool", (e) => events.push(e));
    return events;
  } finally {
    await live.close();
  }
}

test("(a) a denied tool is actually blocked — the tool never executes", async () => {
  const record: ToolRecord = { calls: 0, lastArgs: undefined, resultText: "irrelevant" };
  const policy: Policy = {
    default: "allow",
    rules: [{ match: "secret_echo", action: "deny", reason: "denied by test policy" }],
  };

  const events = await runTurn({ policy, tool: makeStubTool(record), toolArgs: { token: "anything" } });

  expect(record.calls).toBe(0); // the tool body never ran
  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events.at(-1)?.type).toBe("done"); // turn still settles
});

test("(a2) deny-by-default: an unmatched tool is blocked when default is deny", async () => {
  const record: ToolRecord = { calls: 0, lastArgs: undefined, resultText: "irrelevant" };
  const policy: Policy = { default: "deny", rules: [] }; // secret_echo matches nothing -> default deny

  const events = await runTurn({ policy, tool: makeStubTool(record), toolArgs: { token: "anything" } });

  expect(record.calls).toBe(0); // unmatched tool blocked by deny-by-default
  expect(events.at(-1)?.type).toBe("done");
});

test("(a3) ask fails closed: an ask decision with no interactive UI blocks the tool", async () => {
  const record: ToolRecord = { calls: 0, lastArgs: undefined, resultText: "irrelevant" };
  const policy: Policy = {
    default: "allow",
    rules: [{ match: "secret_echo", action: "ask" }],
  };

  // runTurn drives the headless createLiveSession path (no dialog UI), so "ask" must fail closed.
  const events = await runTurn({ policy, tool: makeStubTool(record), toolArgs: { token: "anything" } });

  expect(record.calls).toBe(0); // no UI -> ask denies rather than allowing
  expect(events.at(-1)?.type).toBe("done");
});

test("(b) a secret in tool args is redacted before the tool sees it", async () => {
  const record: ToolRecord = { calls: 0, lastArgs: undefined, resultText: "no secret here" };
  const policy: Policy = {
    default: "allow",
    rules: [],
    redact: [{ pattern: "sk-LIVE-[A-Za-z0-9]+", replace: PLACEHOLDER }],
  };

  await runTurn({ policy, tool: makeStubTool(record), toolArgs: { token: LIVE_SECRET } });

  expect(record.calls).toBe(1);
  expect((record.lastArgs as { token?: string }).token).toBe(PLACEHOLDER);
  expect(JSON.stringify(record.lastArgs)).not.toContain("sk-LIVE-");
});

test("a denied model refuses to start the session (fail-closed model gate)", async () => {
  const { store, manager, registry } = buildCredentials();
  await store.set("api-key:a", "key-a");
  const policy: Policy = {
    default: "allow",
    rules: [],
    models: { deny: ["anthropic/claude-sonnet-5"] },
  };

  await expect(
    createLiveSession({
      harnessPath: exampleHarness,
      manager,
      registry,
      profile: "work",
      cwd: tmp,
      agentDir: join(tmp, "agent"),
      noExtensions: true,
      policy,
      modelRegistryOverride: createToolCallingStubModelRegistry({
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        toolName: "secret_echo",
        toolArgs: {},
        finalReply: "unused",
      }),
    }),
  ).rejects.toThrow(/denied by policy/);
});

test("(c) a secret in the tool RESULT is redacted before it re-enters context", async () => {
  const record: ToolRecord = {
    calls: 0,
    lastArgs: undefined,
    resultText: `the result leaks ${LIVE_SECRET} in its text`,
  };
  const policy: Policy = {
    default: "allow",
    rules: [],
    redact: [{ pattern: "sk-LIVE-[A-Za-z0-9]+", replace: PLACEHOLDER }],
  };

  let contextSeen: string | undefined;
  await runTurn({
    policy,
    tool: makeStubTool(record),
    toolArgs: { token: "harmless" },
    onSecondTurnContext: (context) => {
      contextSeen = JSON.stringify(context.messages);
    },
  });

  expect(record.calls).toBe(1);
  expect(contextSeen).toBeDefined();
  // The tool result carried the secret; by the time it re-enters the model
  // context for the next provider call, it must be redacted.
  expect(contextSeen).toContain(PLACEHOLDER);
  expect(contextSeen).not.toContain("sk-LIVE-");
});
