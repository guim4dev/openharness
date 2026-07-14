import { z } from "zod";
import { PARAMETERIZED, PARAMETERIZED_TOOL } from "./match-form.ts";
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

  // Fail LOUD on a parameterized `name(<glob>)` rule whose tool name is not
  // `bash`. Argument-matching only exists for bash's `command`; for any other
  // tool the matcher can never satisfy it, so such a rule is a silent no-op —
  // e.g. a deny written as `mcp__shell__exec(*rm*)` would never fire. A security
  // rule must never silently become a no-op, so we reject it at load time.
  for (const rule of parsed.data.rules) {
    const m = PARAMETERIZED.exec(rule.match);
    if (m && m[1].trim() !== PARAMETERIZED_TOOL) {
      throw new PolicyError(
        `policy rule ${JSON.stringify(rule.match)}: argument-matching is only supported for ${PARAMETERIZED_TOOL}(...)`,
      );
    }
  }
  return parsed.data;
}
