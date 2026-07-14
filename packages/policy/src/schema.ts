import { z } from "zod";
import { isMalformedMatch } from "./match-form.ts";
import type { Policy } from "./types.ts";

export class PolicyError extends Error {}

const action = z.enum(["allow", "deny", "ask"]);

/**
 * Zod schema for `policy.json`. `default` is fail-closed: when the source omits
 * it the policy denies unmatched tool calls. `rules` defaults to an empty list.
 */
export const policySchema: z.ZodType<Policy, z.ZodTypeDef, unknown> = z.object({
  default: action.default("deny"),
  rules: z
    .array(
      z.object({
        match: z.string().min(1),
        action,
        reason: z.string().optional(),
      }),
    )
    .default([]),
  models: z
    .object({
      allow: z.array(z.string().min(1)).optional(),
      deny: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  redact: z
    .array(
      z.object({
        pattern: z.string().min(1),
        replace: z.string(),
        flags: z.string().optional(),
      }),
    )
    .optional(),
});

/** Parse+validate an unknown value into a Policy, throwing PolicyError on failure. */
export function parsePolicy(raw: unknown): Policy {
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) throw new PolicyError(`policy is invalid:\n${parsed.error.toString()}`);

  // Parameterized `name(<glob>)` argument-matching is supported for ANY tool
  // (gap #2): bash matches its `command`, every other tool its canonical arg
  // string. But a match that LOOKS parameterized yet is malformed — empty tool
  // name (`(x)`) or unbalanced parens (`bash(x`, `bash(x))`) — would fall
  // through to plain tool-name globbing and silently never match. A security
  // rule must never silently become a no-op, so we reject those at load time.
  for (const rule of parsed.data.rules) {
    if (isMalformedMatch(rule.match)) {
      throw new PolicyError(
        `policy rule ${JSON.stringify(rule.match)}: malformed match — expected a plain tool-name glob or a parameterized \`name(<glob>)\` with a non-empty name and balanced parens`,
      );
    }
  }
  return parsed.data;
}
