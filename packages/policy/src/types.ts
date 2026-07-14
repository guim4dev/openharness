/** The three decisions a policy can render for a tool call or the session default. */
export type PolicyAction = "allow" | "deny" | "ask";

/**
 * One ordered rule. `match` is a Claude Code-style glob over the tool identity:
 * - the tool name (`read`, `write`, `mcp__linear__delete_*`), OR
 * - the parameterized `<tool>(<glob>)` form: for `bash` the glob matches the
 *   command string (e.g. `bash(git *)`); for any other tool it matches a
 *   case-insensitive canonical string of the tool's args, so a keyword in any
 *   (even nested) arg fires it (e.g. `mcp__db__write_query(*DELETE*)`).
 * First matching rule wins; an unmatched call falls through to `Policy.default`.
 */
export interface PolicyRule {
  match: string;
  action: PolicyAction;
  /** Surfaced to the model as the tool-result error when this rule blocks. */
  reason?: string;
}

/**
 * A secret-redaction rule. `pattern` is a JavaScript RegExp source; every match
 * is replaced by `replace`. `flags` defaults to `g` and is always forced to
 * include `g` so redaction replaces ALL occurrences (never just the first).
 */
export interface RedactRule {
  pattern: string;
  replace: string;
  flags?: string;
}

/**
 * Model gate. `deny` always wins; if `allow` is present and non-empty it acts as
 * an allow-list (a model must match to be permitted). Patterns are globs matched
 * against both `<provider>/<model>` and the bare `<model>` id.
 */
export interface PolicyModels {
  allow?: string[];
  deny?: string[];
}

/**
 * A resolved, validated policy. `default` governs unmatched tool calls and is
 * `deny` when the source omits it (fail-closed).
 */
export interface Policy {
  default: PolicyAction;
  rules: PolicyRule[];
  models?: PolicyModels;
  redact?: RedactRule[];
}

/** Result of evaluating a single tool call against a policy. */
export interface ToolEvaluation {
  decision: PolicyAction;
  /** Present only when the matched rule carried a `reason`. */
  reason?: string;
  /** A deep copy of the tool args with redaction applied. Never mutates the input. */
  redactedArgs: unknown;
}
