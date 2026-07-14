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
