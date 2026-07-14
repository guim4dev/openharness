/**
 * Shared shape of the two policy `match` forms, used by both the matcher
 * (`engine.ts`) and the loader validation (`schema.ts`). Kept in its own module
 * so the two can share this without importing each other (no cycle).
 *
 * - Plain form (`read`, `mcp__linear__delete_*`): a glob over the tool NAME.
 * - Parameterized form (`bash(<glob>)`): the name part globs the tool name AND
 *   the inner part globs the tool's command string.
 *
 * A trailing `(...)` denotes the parameterized form. Tool names never contain
 * parens, so a name with no parens is a plain tool-name glob.
 */
export const PARAMETERIZED = /^([^()]+)\((.*)\)$/s;

/**
 * The ONLY tool whose parameterized `name(<glob>)` form is supported: `bash`
 * exposes a `command` argument to match against. For any other tool there is no
 * argument to glob, so a parameterized rule could never match and would be a
 * silent no-op — the loader rejects it instead (see `parsePolicy`).
 */
export const PARAMETERIZED_TOOL = "bash";
