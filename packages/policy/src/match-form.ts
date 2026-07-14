/**
 * Shared shape of the two policy `match` forms, used by both the matcher
 * (`engine.ts`) and the loader validation (`schema.ts`). Kept in its own module
 * so the two can share this without importing each other (no cycle).
 *
 * - Plain form (`read`, `mcp__linear__delete_*`): a glob over the tool NAME.
 * - Parameterized form (`name(<glob>)`): the name part globs the tool name AND
 *   the inner part globs an argument string. For `bash` the argument string is
 *   its `command` (matched case-SENSITIVELY, unchanged). For every OTHER tool it
 *   is the tool's CANONICAL ARG STRING — all string values in the input, joined
 *   by newline — matched case-INSENSITIVELY (see `engine.ts`).
 *
 * A well-formed parameterized match is a non-empty, paren-free tool-name part
 * followed by a balanced trailing `(...)`. Tool names never contain parens, so a
 * name with no parens is a plain tool-name glob.
 */
export const PARAMETERIZED = /^([^()]+)\((.*)\)$/s;

/**
 * The one tool whose parameterized argument is its `command` and is matched
 * case-SENSITIVELY. Every other tool matches against its canonical arg string
 * case-insensitively. (Previously this named the ONLY tool that could be
 * parameterized at all; arg-matching now works for any tool — gap #2 closed.)
 */
export const BASH_TOOL = "bash";

/**
 * True when `match` contains parens but is NOT a well-formed `name(<glob>)` —
 * i.e. an empty tool name (`(x)`) or unbalanced parens (`bash(x`, `bash(x))`).
 * Such a string would otherwise fall through to plain tool-name globbing and
 * silently never match (a security no-op), so the loader rejects it. A plain
 * glob with no parens is always well-formed.
 */
export function isMalformedMatch(match: string): boolean {
  if (!match.includes("(") && !match.includes(")")) return false; // plain glob
  const m = PARAMETERIZED.exec(match);
  if (!m) return true; // has parens but not `name(...)` — empty name or no closer
  // Well-formed `name(...)` shell; require the inner parens to balance so
  // `bash(x))` / `bash((x)` don't slip through as a valid-looking rule.
  let depth = 0;
  for (const ch of m[2]) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return true;
  }
  return depth !== 0;
}
