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

test("rejects a parameterized match on a non-bash tool (would silently never match)", () => {
  // A deny written as `mcp__shell__exec(*rm*)` can never fire (only bash exposes
  // an argument to glob), so it must be rejected at load rather than becoming a
  // silent no-op that a reader assumes is protecting them.
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "mcp__shell__exec(*rm*)", action: "deny" }] }),
  ).toThrow(PolicyError);
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "read(secret *)", action: "deny" }] }),
  ).toThrow(/argument-matching is only supported for bash/);

  // The supported bash(...) form still loads, as does a plain (unparameterized) glob.
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "bash(rm -rf *)", action: "deny" }] }),
  ).not.toThrow();
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "mcp__shell__exec", action: "deny" }] }),
  ).not.toThrow();
});

test("schema is exported for external validation", () => {
  expect(policySchema.safeParse({ default: "deny" }).success).toBe(true);
});
