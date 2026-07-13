import { expect, test } from "vitest";
import { parsePolicy, PolicyError, policySchema } from "./schema.ts";

test("parses a full policy", () => {
  const p = parsePolicy({
    default: "allow",
    rules: [
      { match: "mcp__*__delete_*", action: "deny", reason: "no deletes" },
      { match: "bash(rm -rf *)", action: "ask" },
    ],
    models: { allow: ["anthropic/claude-*"], deny: ["openai/*"] },
    redact: [{ pattern: "sk-LIVE-[A-Za-z0-9]+", replace: "sk-REDACTED" }],
  });
  expect(p.default).toBe("allow");
  expect(p.rules).toHaveLength(2);
  expect(p.models?.deny).toEqual(["openai/*"]);
  expect(p.redact?.[0].replace).toBe("sk-REDACTED");
});

test("default is fail-closed to deny when omitted", () => {
  const p = parsePolicy({ rules: [{ match: "read", action: "allow" }] });
  expect(p.default).toBe("deny");
});

test("rules default to empty when omitted", () => {
  const p = parsePolicy({ default: "allow" });
  expect(p.rules).toEqual([]);
});

test("rejects an unknown action", () => {
  expect(() => parsePolicy({ default: "maybe" })).toThrow(PolicyError);
  expect(() => parsePolicy({ default: "allow", rules: [{ match: "x", action: "nope" }] })).toThrow(
    PolicyError,
  );
});

test("rejects an empty match", () => {
  expect(() => parsePolicy({ default: "allow", rules: [{ match: "", action: "deny" }] })).toThrow(
    PolicyError,
  );
});

test("schema is exported for external validation", () => {
  expect(policySchema.safeParse({ default: "deny" }).success).toBe(true);
});
