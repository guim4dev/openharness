import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const DEFAULT_APP_ID = "openharness";
/** Keep the final path segment short and filesystem-friendly across OSes. */
const MAX_APP_ID_LENGTH = 128;
/** Length (hex chars) of the raw-id disambiguation suffix. See `configDir`. */
const ID_HASH_LENGTH = 10;
/**
 * Windows reserved device names (case-insensitive, extension-less). If the
 * sanitized segment collides with one of these, a real Windows path segment
 * of that exact name refers to a device, not a directory.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** Result of sanitizing a raw app id into a safe path segment. */
interface SanitizedId {
  /** The safe path segment. */
  segment: string;
  /**
   * True when `id` sanitized to nothing meaningful (empty, or dots-only) and
   * `segment` is therefore the default app id used as a fallback — as opposed
   * to a real id that merely happens to sanitize to that exact string.
   */
  isFallback: boolean;
}

/**
 * Sanitize an arbitrary string into a single safe path segment: lowercase,
 * any char outside [a-z0-9._-] becomes '-', repeated '-' collapse to one,
 * leading/trailing '-' are stripped, length is capped, and a result that is
 * empty or nothing but dots (".", "..", "...") — which would otherwise resolve
 * to the same or a parent directory — falls back to the default app id.
 * Finally, a segment that collides (case-insensitively) with a Windows
 * reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9) is prefixed with
 * "app-", since a real path segment of that exact name refers to a device on
 * Windows, not a directory.
 *
 * This step is intentionally lossy (e.g. "app!id" and "app@id" both collapse
 * to "app-id", and case is folded) — it exists only to guarantee a SAFE path
 * segment, not a unique one. Callers that need distinct raw ids to land in
 * distinct directories must not rely on this function alone; see `configDir`.
 */
function sanitizeAppId(id: string): SanitizedId {
  const sanitized = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_APP_ID_LENGTH);
  if (sanitized.length === 0 || /^\.+$/.test(sanitized)) {
    return { segment: DEFAULT_APP_ID, isFallback: true };
  }
  if (WINDOWS_RESERVED_NAMES.has(sanitized)) {
    return { segment: `app-${sanitized}`, isFallback: false };
  }
  return { segment: sanitized, isFallback: false };
}

/**
 * Cross-platform per-user config dir for OpenHarness, namespaced per app
 * identifier so multiple branded/white-labeled apps on one machine get
 * isolated credentials, audit logs, and state instead of sharing one dir.
 *
 * Effective id resolution: `appId` arg -> `OPENHARNESS_APP_ID` env -> "openharness".
 * The id is sanitized to a single safe path segment before use (see
 * `sanitizeAppId`) — it can never introduce a path separator or traversal.
 *
 * `sanitizeAppId` alone is lossy and NOT injective (distinct raw ids can
 * collapse to the same sanitized segment — different case, punctuation-only
 * differences, or ids that agree on their first `MAX_APP_ID_LENGTH` chars).
 * Two distinct brands landing in the same dir would defeat the whole point of
 * per-app isolation, so whenever an id is EXPLICITLY provided (`appId` arg or
 * `OPENHARNESS_APP_ID` env) and sanitizes to something real, the final segment
 * is `sanitizeAppId(rawId) + "-" + sha256(rawId).slice(0, ID_HASH_LENGTH)` — a
 * short hex digest of the RAW (pre-sanitization) id, so distinct raw ids
 * always produce distinct directories regardless of what sanitization did to
 * them.
 *
 * Two cases deliberately do NOT get a hash suffix, and just resolve to the
 * bare "openharness" dir:
 *   - No id at all (`appId` arg and `OPENHARNESS_APP_ID` env both unset) —
 *     the true default, unchanged so existing dev setups and tests see no
 *     difference.
 *   - An explicit id that sanitizes to nothing meaningful (empty, or
 *     dots-only, e.g. "..") — treated the same as "no id", since it carries
 *     no real identity to disambiguate in the first place.
 */
export function configDir(appId?: string): string {
  if (process.env.OPENHARNESS_DIR) {
    // Full, UNSANITIZED override for advanced/test use: used verbatim, no
    // sanitization or namespacing applied — the caller owns the path.
    return process.env.OPENHARNESS_DIR;
  }
  const rawId = appId ?? process.env.OPENHARNESS_APP_ID;
  let id: string;
  if (rawId === undefined) {
    id = DEFAULT_APP_ID;
  } else {
    const { segment, isFallback } = sanitizeAppId(rawId);
    id = isFallback
      ? segment
      : `${segment}-${createHash("sha256").update(rawId, "utf8").digest("hex").slice(0, ID_HASH_LENGTH)}`;
  }
  const p = platform();
  if (p === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), id);
  if (p === "darwin") return join(homedir(), "Library", "Application Support", id);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), id);
}
