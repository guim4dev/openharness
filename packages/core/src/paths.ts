import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Cross-platform per-user config dir for OpenHarness. */
export function configDir(): string {
  if (process.env.OPENHARNESS_DIR) return process.env.OPENHARNESS_DIR;
  const p = platform();
  if (p === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "openharness");
  if (p === "darwin") return join(homedir(), "Library", "Application Support", "openharness");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "openharness");
}
