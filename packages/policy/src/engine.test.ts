import { describe, expect, test } from "vitest";
import { checkModel, decideTool, evaluateTool, matchToolIdentity, redact } from "./engine.ts";
import type { Policy } from "./types.ts";

function policy(p: Partial<Policy>): Policy {
  return { default: "allow", rules: [], ...p };
}

describe("matchToolIdentity", () => {
  test("plain glob over the tool name", () => {
    expect(matchToolIdentity("read", "read", {})).toBe(true);
    expect(matchToolIdentity("write", "read", {})).toBe(false);
    expect(matchToolIdentity("mcp__linear__delete_*", "mcp__linear__delete_issue", {})).toBe(true);
    expect(matchToolIdentity("mcp__linear__delete_*", "mcp__linear__create_issue", {})).toBe(false);
    expect(matchToolIdentity("mcp__*__*", "mcp__github__create_pr", {})).toBe(true);
  });

  test("parameterized bash(<glob>) matches the command", () => {
    expect(matchToolIdentity("bash(git *)", "bash", { command: "git status" })).toBe(true);
    expect(matchToolIdentity("bash(git *)", "bash", { command: "git push origin" })).toBe(true);
    expect(matchToolIdentity("bash(git *)", "bash", { command: "rm -rf /" })).toBe(false);
    expect(matchToolIdentity("bash(rm -rf *)", "bash", { command: "rm -rf /tmp/x" })).toBe(true);
  });

  test("parameterized form never matches a non-bash tool", () => {
    expect(matchToolIdentity("read(secret *)", "read", { command: "secret x" })).toBe(false);
    // a bash command with no command field is treated as empty string
    expect(matchToolIdentity("bash(*)", "bash", {})).toBe(true);
  });
});

describe("decideTool — first-match wins, default fallthrough", () => {
  const p = policy({
    default: "deny",
    rules: [
      { match: "read", action: "allow" },
      { match: "bash(git *)", action: "allow" },
      { match: "bash(*)", action: "ask", reason: "confirm shell" },
      { match: "mcp__*__delete_*", action: "deny", reason: "no deletes" },
    ],
  });

  test("first matching rule wins", () => {
    expect(decideTool(p, "read", {}).decision).toBe("allow");
    expect(decideTool(p, "bash", { command: "git log" }).decision).toBe("allow");
    // falls past bash(git *) to bash(*)
    expect(decideTool(p, "bash", { command: "ls -la" })).toEqual({ decision: "ask", reason: "confirm shell" });
    expect(decideTool(p, "mcp__linear__delete_issue", {})).toEqual({ decision: "deny", reason: "no deletes" });
  });

  test("unmatched tool falls through to default", () => {
    expect(decideTool(p, "write", {}).decision).toBe("deny");
  });

  test("default=deny blocks an unmatched tool", () => {
    const denyDefault = policy({ default: "deny", rules: [{ match: "read", action: "allow" }] });
    expect(decideTool(denyDefault, "some_unknown_tool", {}).decision).toBe("deny");
    expect(decideTool(denyDefault, "read", {}).decision).toBe("allow");
  });
});

describe("redact — deep copy, never mutates input", () => {
  const p = policy({
    redact: [
      { pattern: "sk-LIVE-[A-Za-z0-9]+", replace: "sk-REDACTED" },
      { pattern: "AKIA[0-9A-Z]{16}", replace: "AKIA****REDACTED" },
    ],
  });

  test("replaces a secret in a top-level string", () => {
    expect(redact(p, "token is sk-LIVE-abc123 here")).toBe("token is sk-REDACTED here");
  });

  test("replaces a secret in tool args and leaves the input untouched", () => {
    const args = { command: "curl -H 'auth: sk-LIVE-deadbeef'", timeout: 30 };
    const out = redact(p, args) as typeof args;
    expect(out.command).toBe("curl -H 'auth: sk-REDACTED'");
    expect(out.timeout).toBe(30);
    // input is not mutated
    expect(args.command).toBe("curl -H 'auth: sk-LIVE-deadbeef'");
    // it is a deep copy
    expect(out).not.toBe(args);
  });

  test("replaces a secret nested in a result object/array", () => {
    const result = {
      content: [
        { type: "text", text: "your key AKIAABCDEFGHIJKLMNOP is set" },
        { type: "text", text: "and sk-LIVE-xyz789 too" },
      ],
      meta: { nested: { deep: "sk-LIVE-000" } },
    };
    const out = redact(p, result) as typeof result;
    expect(out.content[0].text).toBe("your key AKIA****REDACTED is set");
    expect(out.content[1].text).toBe("and sk-REDACTED too");
    expect(out.meta.nested.deep).toBe("sk-REDACTED");
    // original untouched
    expect(result.content[0].text).toContain("AKIAABCDEFGHIJKLMNOP");
  });

  test("replaces ALL occurrences even when flags omit g", () => {
    const twice = policy({ redact: [{ pattern: "secret", replace: "X", flags: "i" }] });
    expect(redact(twice, "secret secret SECRET")).toBe("X X X");
  });

  test("no redact rules => deep copy with values intact", () => {
    const plain = policy({});
    const args = { a: { b: 1 }, s: "keep me" };
    const out = redact(plain, args) as typeof args;
    expect(out).toEqual(args);
    expect(out).not.toBe(args);
    expect(out.a).not.toBe(args.a);
  });
});

describe("evaluateTool — decision + redactedArgs", () => {
  const p = policy({
    default: "deny",
    rules: [{ match: "bash(*)", action: "allow" }],
    redact: [{ pattern: "sk-LIVE-[A-Za-z0-9]+", replace: "sk-REDACTED" }],
  });

  test("returns decision and a redacted deep copy", () => {
    const args = { command: "echo sk-LIVE-abc" };
    const evalued = evaluateTool(p, "bash", args);
    expect(evalued.decision).toBe("allow");
    expect((evalued.redactedArgs as typeof args).command).toBe("echo sk-REDACTED");
    expect(args.command).toBe("echo sk-LIVE-abc"); // input untouched
  });

  test("carries the rule reason on a deny", () => {
    const denied = policy({ default: "deny", rules: [{ match: "danger", action: "deny", reason: "nope" }] });
    expect(evaluateTool(denied, "danger", {})).toMatchObject({ decision: "deny", reason: "nope" });
  });
});

describe("checkModel — deny wins, allow-list gates", () => {
  test("no models section => allow everything", () => {
    expect(checkModel(policy({}), "anthropic", "claude-sonnet-5")).toBe("allow");
  });

  test("deny wins over allow", () => {
    const p = policy({ models: { allow: ["claude-*"], deny: ["claude-opus-*"] } });
    expect(checkModel(p, "anthropic", "claude-sonnet-5")).toBe("allow");
    expect(checkModel(p, "anthropic", "claude-opus-4")).toBe("deny");
  });

  test("allow-list gates: unlisted model is denied", () => {
    const p = policy({ models: { allow: ["anthropic/claude-sonnet-*"] } });
    expect(checkModel(p, "anthropic", "claude-sonnet-5")).toBe("allow");
    expect(checkModel(p, "anthropic", "claude-haiku-4")).toBe("deny");
    expect(checkModel(p, "openai", "gpt-5")).toBe("deny");
  });

  test("deny-only: everything not denied is allowed", () => {
    const p = policy({ models: { deny: ["openai/*"] } });
    expect(checkModel(p, "openai", "gpt-5")).toBe("deny");
    expect(checkModel(p, "anthropic", "claude-sonnet-5")).toBe("allow");
  });

  test("matches bare model id as well as provider/model", () => {
    const p = policy({ models: { deny: ["gpt-4o"] } });
    expect(checkModel(p, "openai", "gpt-4o")).toBe("deny");
  });
});
