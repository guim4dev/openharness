/**
 * Compile a Claude Code-style glob into an anchored RegExp.
 * `*` matches any run of characters (including none), `?` matches exactly one.
 * The `s` flag lets `.` span newlines so multi-line bash commands still match.
 * All other regex metacharacters are escaped and matched literally.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s");
}

/** True when `value` matches the glob in full. */
export function globMatch(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}
