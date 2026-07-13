import { z } from "zod";
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
  return parsed.data;
}
