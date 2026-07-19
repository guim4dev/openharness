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

test("parameterized arg-matching is now supported for ANY tool (gap #2 closed)", () => {
  // Previously rejected as a bash-only feature; now these load, matching against
  // the tool's canonical arg string (case-insensitive).
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "mcp__shell__exec(*rm*)", action: "deny" }] }),
  ).not.toThrow();
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "mcp__back_office__write_query(*DROP*)", action: "deny" }] }),
  ).not.toThrow();
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "read(secret *)", action: "deny" }] }),
  ).not.toThrow();

  // bash(...) and plain (unparameterized) globs still load too.
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "bash(rm -rf *)", action: "deny" }] }),
  ).not.toThrow();
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "mcp__shell__exec", action: "deny" }] }),
  ).not.toThrow();
});

test("rejects genuinely malformed matches (unbalanced parens, empty tool name)", () => {
  // Empty tool name: would fall through to a plain tool-name glob and silently
  // never match (tool names contain no parens) — reject rather than no-op.
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "(*DROP*)", action: "deny" }] }),
  ).toThrow(/malformed/);
  // Unbalanced parens.
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "bash(git *", action: "deny" }] }),
  ).toThrow(PolicyError);
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "mcp__db__query(*DROP*", action: "deny" }] }),
  ).toThrow(/malformed/);
  expect(() =>
    parsePolicy({ default: "allow", rules: [{ match: "bash(git *))", action: "deny" }] }),
  ).toThrow(PolicyError);
});

test("schema is exported for external validation", () => {
  expect(policySchema.safeParse({ default: "deny" }).success).toBe(true);
});

test("rejects a blob-field ALLOW (fail-open) but accepts field-scoped, bash, and deny/ask", () => {
  // A non-bash blob-content ALLOW is fail-open (smuggling across fields) → rejected.
  expect(() =>
    parsePolicy({ default: "deny", rules: [{ match: "mcp__db__query(*SELECT*)", action: "allow" }] }),
  ).toThrow(/fail-OPEN|field-scoped/i);
  // Field-scoped allow pins the governed field → accepted (the sound form).
  expect(() =>
    parsePolicy({ default: "deny", rules: [{ match: "mcp__db__query(sql=SELECT *)", action: "allow" }] }),
  ).not.toThrow();
  // bash arg-content allow matches its single `command` field → accepted.
  expect(() =>
    parsePolicy({ default: "deny", rules: [{ match: "bash(git *)", action: "allow" }] }),
  ).not.toThrow();
  // Non-bash blob deny/ask are fail-safe → accepted.
  expect(() =>
    parsePolicy({
      default: "allow",
      rules: [
        { match: "mcp__db__query(*DROP*)", action: "deny" },
        { match: "mcp__db__query(*DELETE*)", action: "ask" },
      ],
    }),
  ).not.toThrow();
  // The rejection also covers principal (group) rules.
  expect(() =>
    parsePolicy({
      default: "deny",
      principals: [{ group: "eng", rules: [{ match: "mcp__db__query(*read*)", action: "allow" }] }],
    }),
  ).toThrow(/fail-OPEN|field-scoped/i);
});
