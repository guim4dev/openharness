import { homedir, platform } from "node:os";
import { join } from "node:path";

const DEFAULT_APP_ID = "openharness";
/** Keep the final path segment short and filesystem-friendly across OSes. */
const MAX_APP_ID_LENGTH = 128;

/**
 * Sanitize an arbitrary string into a single safe path segment: lowercase,
 * any char outside [a-z0-9._-] becomes '-', repeated '-' collapse to one,
 * leading/trailing '-' are stripped, length is capped, and a result that is
 * empty or nothing but dots (".", "..", "...") — which would otherwise resolve
 * to the same or a parent directory — falls back to the default app id.
 */
function sanitizeAppId(id: string): string {
  const sanitized = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_APP_ID_LENGTH);
  if (sanitized.length === 0 || /^\.+$/.test(sanitized)) return DEFAULT_APP_ID;
  return sanitized;
}

/**
 * Cross-platform per-user config dir for OpenHarness, namespaced per app
 * identifier so multiple branded/white-labeled apps on one machine get
 * isolated credentials, audit logs, and state instead of sharing one dir.
 *
 * Effective id resolution: `appId` arg -> `OPENHARNESS_APP_ID` env -> "openharness".
 * The id is sanitized to a single safe path segment before use (see
 * `sanitizeAppId`) — it can never introduce a path separator or traversal.
 */
export function configDir(appId?: string): string {
  if (process.env.OPENHARNESS_DIR) return process.env.OPENHARNESS_DIR;
  const id = sanitizeAppId(appId ?? process.env.OPENHARNESS_APP_ID ?? DEFAULT_APP_ID);
  const p = platform();
  if (p === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), id);
  if (p === "darwin") return join(homedir(), "Library", "Application Support", id);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), id);
}
