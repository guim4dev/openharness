import { expect, test } from "vitest";
import { parsePolicy } from "@openharness/policy";
import { decide } from "./pdp.ts";

const principal = (groups: string[]) => ({ groups });

test("a principal's group rule grants ahead of a base ask", () => {
  const policy = parsePolicy({
    default: "deny",
    rules: [{ match: "mcp__github__merge_pr", action: "ask" }],
    principals: [{ group: "leads", rules: [{ match: "mcp__github__merge_pr", action: "allow" }] }],
  });
  // A lead is allowed; a non-lead falls through to the base `ask`.
  expect(decide(policy, principal(["leads"]), "mcp__github__merge_pr", {}).decision).toBe("allow");
  expect(decide(policy, principal(["eng"]), "mcp__github__merge_pr", {}).decision).toBe("ask");
});

test("argument-level rule fires for a principal (recipient allowlist on a send tool)", () => {
  const policy = parsePolicy({
    default: "deny",
    rules: [{ match: "mcp__mail__send", action: "allow" }],
    principals: [
      // Support can only send to @acme.test; anything else denied.
      { group: "support", rules: [{ match: "mcp__mail__send(*@acme.test*)", action: "allow" }, { match: "mcp__mail__send", action: "deny", reason: "external recipient" }] },
    ],
  });
  expect(decide(policy, principal(["support"]), "mcp__mail__send", { to: "x@acme.test" }).decision).toBe("allow");
  const external = decide(policy, principal(["support"]), "mcp__mail__send", { to: "x@evil.com" });
  expect(external.decision).toBe("deny");
  expect(external.reason).toBe("external recipient");
});

test("no matching group falls through to the base policy", () => {
  const policy = parsePolicy({
    default: "deny",
    rules: [{ match: "read", action: "allow" }],
    principals: [{ group: "admins", rules: [{ match: "*", action: "allow" }] }],
  });
  expect(decide(policy, principal(["nobody"]), "read", {}).decision).toBe("allow"); // base
  expect(decide(policy, principal(["nobody"]), "write", {}).decision).toBe("deny"); // base default
});

test("redaction from the base policy still applies through the PDP", () => {
  const policy = parsePolicy({
    default: "allow",
    rules: [],
    redact: [{ pattern: "AKIA[0-9A-Z]{16}", replace: "[aws]" }],
  });
  const res = decide(policy, principal([]), "read", { note: "key AKIA0000000000000000 here" });
  expect(JSON.stringify(res.redactedArgs)).toContain("[aws]");
  expect(JSON.stringify(res.redactedArgs)).not.toContain("AKIA0000000000000000");
});
