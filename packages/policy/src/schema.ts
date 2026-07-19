import { z } from "zod";
import { isMalformedMatch, PARAMETERIZED, FIELD_SCOPED, BASH_TOOL } from "./match-form.ts";
import type { Policy } from "./types.ts";

export class PolicyError extends Error {}

const action = z.enum(["allow", "deny", "ask"]);

const ruleSchema = z.object({
  match: z.string().min(1),
  action,
  reason: z.string().optional(),
});

/**
 * Zod schema for `policy.json`. `default` is fail-closed: when the source omits
 * it the policy denies unmatched tool calls. `rules` defaults to an empty list.
 */
export const policySchema: z.ZodType<Policy, z.ZodTypeDef, unknown> = z.object({
  default: action.default("deny"),
  rules: z.array(ruleSchema).default([]),
  principals: z
    .array(z.object({ group: z.string().min(1), rules: z.array(ruleSchema).default([]) }))
    .optional(),
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
  const allRules = [
    ...parsed.data.rules,
    ...(parsed.data.principals ?? []).flatMap((p) => p.rules),
  ];
  for (const rule of allRules) {
    if (isMalformedMatch(rule.match)) {
      throw new PolicyError(
        `policy rule ${JSON.stringify(rule.match)}: malformed match — expected a plain tool-name glob or a parameterized \`name(<glob>)\` with a non-empty name and balanced parens`,
      );
    }
    // A parameterized ALLOW that matches the BLOB of all argument fields is
    // fail-OPEN: a disallowed value can be smuggled into another field while a
    // benign one satisfies the glob. Only two argument-content ALLOW forms are
    // sound: `bash(<glob>)` (bash matches its single `command`) and the
    // field-scoped `tool(field=<glob>)` (pins the governed field). Refuse a
    // non-bash, non-field-scoped parameterized allow at load rather than let a
    // policy silently permit what its author meant to restrict.
    const p = PARAMETERIZED.exec(rule.match);
    if (p && rule.action === "allow") {
      const isBash = p[1].trim() === BASH_TOOL;
      const isFieldScoped = FIELD_SCOPED.test(p[2]);
      if (!isBash && !isFieldScoped) {
        throw new PolicyError(
          `policy rule ${JSON.stringify(rule.match)}: an argument-content ALLOW over the blob of all fields is fail-OPEN (a disallowed value can be smuggled into another field). Use the field-scoped form \`${p[1].trim()}(<field>=<glob>)\` to pin the governed field, \`bash(<glob>)\`, or an unparameterized allow — or use \`deny\`/\`ask\`.`,
        );
      }
    }
  }
  return parsed.data;
}
