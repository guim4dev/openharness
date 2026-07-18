import { globMatch } from "./glob.ts";
import { BASH_TOOL, PARAMETERIZED } from "./match-form.ts";
import { PolicyError } from "./schema.ts";
import type { Policy, PolicyAction, ToolEvaluation } from "./types.ts";

// ---------------------------------------------------------------------------
// Tool identity matching
// ---------------------------------------------------------------------------

/** `bash`'s `command` argument as a string (missing/non-string => empty). */
function bashCommandString(args: unknown): string {
  const command = (args as { command?: unknown } | null | undefined)?.command;
  return typeof command === "string" ? command : "";
}

/**
 * The canonical argument string of a tool call: EVERY string value in the input,
 * gathered recursively through nested objects and arrays, joined by newline.
 * Non-string values (numbers, booleans, null) contribute nothing. This is the
 * fail-SAFE surface the parameterized arg-glob matches against — a sensitive
 * substring in ANY field (however deeply nested) makes the rule fire.
 */
/**
 * Depth cap on the recursive walk. Pathological nesting (a model can emit
 * JSON-parseable args tens of thousands of levels deep) would otherwise overflow
 * the stack and THROW out of the matcher — and a matcher that throws instead of
 * returning would fail OPEN in the enforcement hook (the tool runs unblocked).
 * Capping keeps the matcher total: strings at or above the cap are still
 * captured (so a sensitive substring in a realistic field still fires the rule),
 * and nesting past it is simply not descended. 256 is far beyond any real tool's
 * argument nesting and far below the stack limit.
 */
const MAX_ARG_DEPTH = 256;

function canonicalArgString(args: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (typeof v === "string") parts.push(v);
    else if (depth >= MAX_ARG_DEPTH) return; // don't descend into pathological nesting
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v !== null && typeof v === "object")
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(args, 0);
  return parts.join("\n");
}

/**
 * Match a policy `match` pattern against a tool call.
 * - Plain form (`read`, `mcp__linear__delete_*`): glob over the tool name.
 * - Parameterized form (`name(<glob>)`): the name part globs the tool name AND
 *   the inner part globs an argument string. For `bash` that is its `command`,
 *   matched case-SENSITIVELY (unchanged). For any OTHER tool it is the canonical
 *   arg string (all string values, recursively), matched case-INSENSITIVELY so
 *   `*DELETE*` also catches `delete`/`Delete` — the fail-safe choice.
 */
export function matchToolIdentity(pattern: string, toolName: string, args: unknown): boolean {
  const parameterized = PARAMETERIZED.exec(pattern);
  if (parameterized) {
    const [, toolGlob, innerGlob] = parameterized;
    if (!globMatch(toolGlob.trim(), toolName)) return false;
    if (toolName === BASH_TOOL) return globMatch(innerGlob, bashCommandString(args));
    return globMatch(innerGlob, canonicalArgString(args), true);
  }
  return globMatch(pattern.trim(), toolName);
}

/** First-match-wins decision for a tool call; unmatched falls through to `default`. */
export function decideTool(
  policy: Policy,
  toolName: string,
  args: unknown,
): { decision: PolicyAction; reason?: string } {
  for (const rule of policy.rules) {
    if (matchToolIdentity(rule.match, toolName, args)) {
      return rule.reason !== undefined
        ? { decision: rule.action, reason: rule.reason }
        : { decision: rule.action };
    }
  }
  return { decision: policy.default };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export interface CompiledRedactor {
  regex: RegExp;
  replace: string;
}

/**
 * Compile every redact rule to a RegExp once. Throws PolicyError on an invalid
 * pattern so misconfiguration fails loud at wiring time rather than silently
 * leaking a secret at runtime. The `g` flag is always forced on so every
 * occurrence is replaced.
 */
export function compileRedactors(policy: Policy): CompiledRedactor[] {
  const rules = policy.redact ?? [];
  return rules.map((rule) => {
    const flags = rule.flags && rule.flags.includes("g") ? rule.flags : `${rule.flags ?? ""}g`;
    try {
      return { regex: new RegExp(rule.pattern, flags), replace: rule.replace };
    } catch (e) {
      throw new PolicyError(
        `invalid redact pattern ${JSON.stringify(rule.pattern)} (flags ${JSON.stringify(flags)}): ${(e as Error).message}`,
      );
    }
  });
}

function redactString(input: string, redactors: CompiledRedactor[]): string {
  let out = input;
  for (const { regex, replace } of redactors) {
    regex.lastIndex = 0;
    out = out.replace(regex, replace);
  }
  return out;
}

function walk(value: unknown, redactors: CompiledRedactor[]): unknown {
  if (typeof value === "string") return redactors.length ? redactString(value, redactors) : value;
  if (Array.isArray(value)) return value.map((v) => walk(v, redactors));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Redact the KEY too, not just the value — a secret can appear as an object
      // key (e.g. a map keyed by token), which would otherwise re-enter the audit
      // log / model context unredacted. (A key that redacts to a colliding
      // placeholder loses fidelity, but never leaks the secret — the right trade.)
      const key = redactors.length ? redactString(k, redactors) : k;
      out[key] = walk(v, redactors);
    }
    return out;
  }
  return value;
}

/**
 * Apply precompiled redactors to a value, returning a deep copy (objects and
 * arrays are rebuilt; the input is never mutated). Reuses the compiled regexes
 * so it is safe to call on a hot path.
 */
export function applyRedactors<T>(redactors: CompiledRedactor[], value: T): T {
  return walk(value, redactors) as T;
}

/**
 * Redact secrets in a value against `policy`. Returns a deep copy; the input is
 * never mutated. Compiles the policy's redactors on each call — for hot paths,
 * prefer `compileRedactors` + `applyRedactors`.
 */
export function redact<T>(policy: Policy, value: T): T {
  return applyRedactors(compileRedactors(policy), value);
}

// ---------------------------------------------------------------------------
// Tool evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a tool call: the first-match decision plus a redacted deep copy of
 * the args. `redactedArgs` is what a caller should hand to the tool when the
 * decision permits execution.
 */
export function evaluateTool(policy: Policy, toolName: string, args: unknown): ToolEvaluation {
  const decided = decideTool(policy, toolName, args);
  const redactedArgs = redact(policy, args);
  return decided.reason !== undefined
    ? { decision: decided.decision, reason: decided.reason, redactedArgs }
    : { decision: decided.decision, redactedArgs };
}

// ---------------------------------------------------------------------------
// Model gate
// ---------------------------------------------------------------------------

/**
 * Gate a provider/model against the policy's model rules. `deny` wins; if an
 * `allow` list is present and non-empty the model must match it, else it is
 * denied. No `models` section => allow everything. Patterns match against both
 * `<provider>/<model>` and the bare `<model>` id.
 */
export function checkModel(policy: Policy, provider: string, model: string): "allow" | "deny" {
  const models = policy.models;
  if (!models) return "allow";
  const identity = `${provider}/${model}`;
  const anyMatch = (patterns: string[] | undefined): boolean =>
    !!patterns && patterns.some((p) => globMatch(p, identity) || globMatch(p, model));

  if (anyMatch(models.deny)) return "deny";
  if (models.allow && models.allow.length > 0) return anyMatch(models.allow) ? "allow" : "deny";
  return "allow";
}
