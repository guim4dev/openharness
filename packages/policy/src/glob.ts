/**
 * Compile a Claude Code-style glob into an anchored RegExp.
 * `*` matches any run of characters (including none), `?` matches exactly one.
 * The `s` flag lets `.` span newlines so multi-line bash commands (and the
 * newline-joined canonical arg string) still match. All other regex
 * metacharacters are escaped and matched literally. Pass `caseInsensitive` to
 * add the `i` flag (used for argument matching, where SQL/keyword case varies).
 */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, caseInsensitive ? "si" : "s");
}

/** True when `value` matches the glob in full. Case-sensitive unless opted in. */
export function globMatch(glob: string, value: string, caseInsensitive = false): boolean {
  return globToRegExp(glob, caseInsensitive).test(value);
}
