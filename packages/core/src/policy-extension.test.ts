import { expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuditSink } from "@openharness/audit";
import type { Policy } from "@openharness/policy";
import { buildPolicyExtension } from "./policy-extension.ts";

const SECRET = "sk-LIVE-deadBEEF0123";
const PLACEHOLDER = "sk-REDACTED";

/** An audit sink whose every record() throws (ENOSPC/EIO/closed-fd surrogate). */
const throwingSink: AuditSink = {
  record() {
    throw new Error("EIO: audit sink is broken");
  },
};

/** Register an extension's handlers into a map so a test can drive them directly. */
async function handlersOf(policy: Policy, audit: AuditSink) {
  const ext = buildPolicyExtension(policy, { audit });
  const factory = typeof ext === "function" ? ext : ext.factory;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const fakePi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  await factory(fakePi);
  return handlers;
}

const REDACT_POLICY: Policy = {
  default: "allow",
  rules: [],
  redact: [{ pattern: "sk-LIVE-[A-Za-z0-9]+", replace: PLACEHOLDER }],
};

test("tool_result redaction FAILS SAFE when the audit sink throws: the returned content is still redacted", async () => {
  const handlers = await handlersOf(REDACT_POLICY, throwingSink);
  const handler = handlers.get("tool_result");
  expect(handler).toBeDefined();

  const result = (await handler!(
    {
      type: "tool_result",
      toolName: "leaky_tool",
      content: [{ type: "text", text: `here is the secret ${SECRET} in the output` }],
      details: { extra: `also ${SECRET}` },
    },
    {},
  )) as { content: unknown; details: unknown } | undefined;

  // The handler did not abort on the throwing sink: the redacted result is
  // returned, so the ORIGINAL unredacted output never re-enters context.
  expect(result).toBeDefined();
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).toContain(PLACEHOLDER);
});

test("tool_call DENY still blocks when the audit sink throws (block is not skipped)", async () => {
  const denyPolicy: Policy = {
    default: "allow",
    rules: [{ match: "danger_tool", action: "deny", reason: "denied by policy" }],
  };
  const handlers = await handlersOf(denyPolicy, throwingSink);
  const handler = handlers.get("tool_call");
  expect(handler).toBeDefined();

  const res = (await handler!(
    { type: "tool_call", toolName: "danger_tool", input: {} },
    { hasUI: false },
  )) as { block?: boolean } | undefined;

  // A throwing audit must not swallow the block — the tool stays denied.
  expect(res?.block).toBe(true);
});

test("tool_call ALLOW redacts args in place even when the audit sink throws", async () => {
  const handlers = await handlersOf(REDACT_POLICY, throwingSink);
  const handler = handlers.get("tool_call");
  expect(handler).toBeDefined();

  const input: Record<string, unknown> = { token: SECRET };
  await handler!({ type: "tool_call", toolName: "any_tool", input }, { hasUI: false });

  // The args the tool executes with are redacted despite the broken sink.
  expect(JSON.stringify(input)).not.toContain(SECRET);
  expect(JSON.stringify(input)).toContain(PLACEHOLDER);
});

/** An in-memory sink that just keeps whatever was recorded, for assertions. */
function recordingSink(): { sink: AuditSink; entries: unknown[] } {
  const entries: unknown[] = [];
  return { sink: { record: (e) => void entries.push(e) }, entries };
}

test("tool_result FAILS CLOSED when redaction compute throws: the model does NOT receive the original content", async () => {
  const { sink, entries } = recordingSink();
  const handlers = await handlersOf(REDACT_POLICY, sink);
  const handler = handlers.get("tool_result");
  expect(handler).toBeDefined();

  // A circular structure makes `applyRedactors`'s object-graph walk recurse
  // forever (RangeError: Maximum call stack size exceeded) rather than throwing
  // a clean, catchable "not serializable" error up front — this is the
  // pathological content the fix must survive.
  const circularBlock: Record<string, unknown> = { type: "text", text: `leaking ${SECRET}` };
  circularBlock.self = circularBlock;

  const result = (await handler!(
    {
      type: "tool_result",
      toolName: "leaky_tool",
      content: [circularBlock],
      details: {},
    },
    {},
  )) as { content: unknown; details?: unknown; isError?: boolean } | undefined;

  expect(result).toBeDefined();
  const serialized = JSON.stringify(result);
  // The original (unredacted, secret-carrying) content must never reach the model.
  expect(serialized).not.toContain(SECRET);
  expect(serialized).toContain("withheld");
  expect(result?.isError).toBe(true);

  // The failure itself is still audited (fail-closed, not fail-silent).
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ type: "tool_result", tool: "leaky_tool", redacted: true });
});

test("tool_result FAILS CLOSED even when the audit sink also throws (compute failure wins, no unredacted fallback)", async () => {
  const handlers = await handlersOf(REDACT_POLICY, throwingSink);
  const handler = handlers.get("tool_result");
  expect(handler).toBeDefined();

  const circularBlock: Record<string, unknown> = { type: "text", text: `leaking ${SECRET}` };
  circularBlock.self = circularBlock;

  const result = (await handler!(
    { type: "tool_result", toolName: "leaky_tool", content: [circularBlock], details: {} },
    {},
  )) as { content: unknown; isError?: boolean } | undefined;

  expect(result).toBeDefined();
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(result?.isError).toBe(true);
});

test("tool_call arg redaction FAILS CLOSED (denies) when compute throws on pathological args, instead of letting original args through", async () => {
  const { sink, entries } = recordingSink();
  const handlers = await handlersOf(REDACT_POLICY, sink);
  const handler = handlers.get("tool_call");
  expect(handler).toBeDefined();

  const circularInput: Record<string, unknown> = { token: SECRET };
  circularInput.self = circularInput;

  const res = (await handler!(
    { type: "tool_call", toolName: "any_tool", input: circularInput },
    { hasUI: false },
  )) as { block?: boolean; reason?: string } | undefined;

  // Compute failure must deny — never fall through to "allow" with the
  // original (unredacted) args reaching the tool.
  expect(res?.block).toBe(true);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ type: "tool_call", tool: "any_tool", decision: "deny" });
});

test("tool_call arg redaction FAILS CLOSED on pathological args even under a DENY policy (audit hash compute never bypasses the block)", async () => {
  const denyPolicy: Policy = {
    default: "allow",
    rules: [{ match: "danger_tool", action: "deny", reason: "denied by policy" }],
  };
  const handlers = await handlersOf(denyPolicy, throwingSink);
  const handler = handlers.get("tool_call");
  expect(handler).toBeDefined();

  const circularInput: Record<string, unknown> = { token: SECRET };
  circularInput.self = circularInput;

  const res = (await handler!(
    { type: "tool_call", toolName: "danger_tool", input: circularInput },
    { hasUI: false },
  )) as { block?: boolean } | undefined;

  expect(res?.block).toBe(true);
});
