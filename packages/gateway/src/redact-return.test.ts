import { expect, test } from "vitest";
import { parsePolicy } from "@openharness/policy";
import { sanitizeResult } from "./redact-return.ts";

const policy = parsePolicy({
  default: "allow",
  rules: [],
  redact: [{ pattern: "AKIA[0-9A-Z]{16}", replace: "[aws]" }],
});

test("redacts a secret an upstream echoed back, before it returns", () => {
  const out = sanitizeResult(policy, {
    content: [{ type: "text", text: "leaked AKIA0000000000000000 in the response" }],
  });
  expect(out.content[0].text).toContain("[aws]");
  expect(out.content[0].text).not.toContain("AKIA0000000000000000");
});

test("caps an oversized text block", () => {
  const big = "x".repeat(50);
  const out = sanitizeResult(policy, { content: [{ type: "text", text: big }] }, 10);
  expect(out.content[0].text.startsWith("xxxxxxxxxx\n…[truncated")).toBe(true);
  expect(out.content[0].text.length).toBeLessThan(big.length);
});

test("a result with no secrets and under the cap is unchanged", () => {
  const out = sanitizeResult(policy, { content: [{ type: "text", text: "plain result" }] });
  expect(out.content[0].text).toBe("plain result");
});

test("preserves the isError flag", () => {
  const out = sanitizeResult(policy, { content: [{ type: "text", text: "err" }], isError: true });
  expect(out.isError).toBe(true);
});
