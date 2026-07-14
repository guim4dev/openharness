import { afterEach, beforeEach, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  InMemorySecretStore,
  CredentialManager,
  AuthProviderRegistry,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";
import type { Policy } from "@openharness/policy";
import { InMemoryAuditSink, verifyAuditLog } from "@openharness/audit";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLiveSession } from "./live-session.ts";
import { buildPolicyExtension } from "./policy-extension.ts";
import { createToolCallingStubModelRegistry } from "./testing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleHarness = join(here, "..", "..", "..", "harnesses", "example");

const LIVE_SECRET = "sk-LIVE-deadBEEF0123";
const PLACEHOLDER = "sk-REDACTED";
const USER_PROMPT = "please call the tool";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oh-audit-live-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function buildCredentials() {
  const store = new InMemorySecretStore();
  const accounts: Account[] = [
    {
      id: "a",
      provider: "anthropic",
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

function makeStubTool(resultText: string): ToolDefinition {
  return {
    name: "secret_echo",
    label: "secret_echo",
    description: "Echoes a token back, and returns some text in its result.",
    parameters: {
      type: "object",
      properties: { token: { type: "string" } },
      required: [],
    } as unknown as ToolDefinition["parameters"],
    async execute() {
      return { content: [{ type: "text", text: resultText }], details: undefined };
    },
  } as ToolDefinition;
}

interface AuditRun {
  auditPath: string;
  content: string;
  lines: Record<string, unknown>[];
}

async function runTurnWithAudit(opts: {
  policy: Policy;
  toolArgs: Record<string, unknown>;
  resultText?: string;
}): Promise<AuditRun> {
  const { store, manager, registry } = buildCredentials();
  await store.set("api-key:a", "key-a");
  const auditPath = join(tmp, "audit", "session.jsonl");

  const live = await createLiveSession({
    harnessPath: exampleHarness,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    policy: opts.policy,
    auditPath,
    customTools: [makeStubTool(opts.resultText ?? "no secret here")],
    modelRegistryOverride: createToolCallingStubModelRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      toolName: "secret_echo",
      toolArgs: opts.toolArgs,
      finalReply: "all done",
    }),
  });

  try {
    await live.prompt(USER_PROMPT, () => {});
  } finally {
    await live.close();
  }

  const content = await readFile(auditPath, "utf8");
  const lines = content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { auditPath, content, lines };
}

test("(a) tool_call is recorded with decision + argsHash; the raw secret is ABSENT from the file", async () => {
  const policy: Policy = {
    default: "allow",
    rules: [],
    redact: [{ pattern: "sk-LIVE-[A-Za-z0-9]+", replace: PLACEHOLDER }],
  };

  const { content, lines } = await runTurnWithAudit({ policy, toolArgs: { token: LIVE_SECRET } });

  const toolCall = lines.find((l) => l.type === "tool_call");
  expect(toolCall).toBeDefined();
  expect(toolCall!.tool).toBe("secret_echo");
  expect(toolCall!.decision).toBe("allow");
  expect(toolCall!.argsHash).toMatch(/^[0-9a-f]{64}$/);

  // The whole point: neither the raw secret nor its redacted placeholder text
  // appear in the file — only the (irreversible) hash of the redacted args.
  expect(content).not.toContain("sk-LIVE-");
  expect(content).not.toContain(LIVE_SECRET);
  expect(content).not.toContain(PLACEHOLDER);
});

test("(b) verifyAuditLog passes on the live log and FAILS after mutating a line", async () => {
  const policy: Policy = { default: "allow", rules: [] };
  const { auditPath } = await runTurnWithAudit({ policy, toolArgs: { token: "harmless" } });

  expect(verifyAuditLog(auditPath)).toEqual({ ok: true });

  // Tamper with the last line's decision without recomputing the chain.
  const raw = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.trim().length > 0);
  const idx = raw.length - 1;
  const rec = JSON.parse(raw[idx]) as Record<string, unknown>;
  rec.tool = "tampered_tool";
  raw[idx] = JSON.stringify(rec);
  await writeFile(auditPath, raw.join("\n") + "\n");

  expect(verifyAuditLog(auditPath)).toEqual({ ok: false, brokenAt: idx });
});

test("(c) a policy-DENIED tool call is recorded with decision:'deny'", async () => {
  const policy: Policy = {
    default: "allow",
    rules: [{ match: "secret_echo", action: "deny", reason: "denied by test policy" }],
  };

  const { lines } = await runTurnWithAudit({ policy, toolArgs: { token: "anything" } });

  const denied = lines.find((l) => l.type === "tool_call" && l.decision === "deny");
  expect(denied).toBeDefined();
  expect(denied!.tool).toBe("secret_echo");
  expect(denied!.argsHash).toMatch(/^[0-9a-f]{64}$/);
});

test("(d) the audit file contains NO prompt/message text", async () => {
  const policy: Policy = {
    default: "allow",
    rules: [],
    redact: [{ pattern: "sk-LIVE-[A-Za-z0-9]+", replace: PLACEHOLDER }],
  };

  const { content, lines } = await runTurnWithAudit({
    policy,
    toolArgs: { token: LIVE_SECRET },
    // The result text embeds BOTH the secret and the prompt; the tool_result
    // entry must store only a hash of it, never the text.
    resultText: `leaks ${LIVE_SECRET} and echoes the ${USER_PROMPT}`,
  });

  // The user prompt must never be written: tool_result records a hash, not the
  // result text, and no entry carries message content.
  expect(content).not.toContain(USER_PROMPT);
  expect(content).not.toContain("sk-LIVE-");

  const toolResult = lines.find((l) => l.type === "tool_result");
  expect(toolResult).toBeDefined();
  expect(toolResult!.resultHash).toMatch(/^[0-9a-f]{64}$/);
  expect(toolResult!.redacted).toBe(true);
});

// The faux-core test provider bypasses `onPayload`, so `before_provider_request`
// never fires under the stub (it does against real provider APIs, which invoke
// onPayload). Drive the handler directly to prove the model_request entry
// records provider/model/tokens ONLY — never the payload's prompt/messages.
test("(e) model_request records provider/model/tokens only — never the payload messages", async () => {
  const sink = new InMemoryAuditSink();
  const ext = buildPolicyExtension(
    { default: "allow", rules: [] },
    { providerId: "anthropic", audit: sink },
  );
  const factory = typeof ext === "function" ? ext : ext.factory;

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const fakePi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  await factory(fakePi);

  const handler = handlers.get("before_provider_request");
  expect(handler).toBeDefined();
  await handler!(
    {
      type: "before_provider_request",
      payload: {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: USER_PROMPT }],
        usage: { input_tokens: 42, output_tokens: 7 },
      },
    },
    { hasUI: false },
  );

  expect(sink.records).toHaveLength(1);
  expect(sink.records[0]).toMatchObject({
    type: "model_request",
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokensIn: 42,
    tokensOut: 7,
  });
  expect(JSON.stringify(sink.records)).not.toContain(USER_PROMPT);
});
