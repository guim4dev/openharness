import { evaluateTool } from "@openharness/policy";
import type { Policy, PolicyRule, ToolEvaluation } from "@openharness/policy";
import type { Principal } from "./auth.ts";

/**
 * The gateway's Policy Decision Point — the AUTHORITATIVE decision, made
 * server-side just before any credential is used (a patched local binary can't
 * skip it). It evaluates the SAME signed policy as the local enforcement, but
 * first layers the caller's per-principal (IdP-group) rules ahead of the base
 * rules, so a group can grant or deny before the shared policy. Reuses
 * `@openharness/policy`'s engine verbatim — arg-level matching and redaction —
 * so there is no second implementation to drift from the client's.
 *
 * Argument-level rules are the point: with a pooled service credential, a
 * tool-NAME-only policy is a privilege-escalation appliance, so send/write-class
 * tools must gate on their arguments (recipient/destination), which this
 * evaluates identically to v1.
 */
export function decide(
  policy: Policy,
  principal: Pick<Principal, "groups">,
  toolName: string,
  args: unknown,
): ToolEvaluation {
  const principalRules: PolicyRule[] = (policy.principals ?? [])
    .filter((p) => principal.groups.includes(p.group))
    .flatMap((p) => p.rules);
  const effective: Policy = principalRules.length
    ? { ...policy, rules: [...principalRules, ...policy.rules] }
    : policy;
  return evaluateTool(effective, toolName, args);
}
