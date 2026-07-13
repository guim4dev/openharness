#!/usr/bin/env node
import { loadAccounts } from "@openharness/core";
import { loadHarnessDefinition } from "@openharness/definition";
import { startSidecar } from "./sidecar.ts";

/**
 * Runnable sidecar entry. The Tauri (Rust) shell spawns this with `node`, reads
 * a single JSON handshake line from stdout — `{"port":<n>,"token":"<t>"}` — and
 * injects it into the webview as `window.__OPENHARNESS__` so the UI can open the
 * loopback WebSocket. Keep the handshake the FIRST parseable JSON object printed
 * to stdout; the Rust side scans lines and takes the first that parses.
 *
 * Config (env, all optional except the harness path):
 *   OH_HARNESS_PATH   path to a harness definition dir (else argv[2])
 *   OH_PROFILE        credential profile to drive (else the harness default)
 *   OH_CWD            working directory for the Pi session (else process.cwd())
 *
 * Credentials: bring-your-own-key via loadAccounts — env keys
 * (ANTHROPIC_API_KEY etc.) plus configDir()/accounts.json, secrets in the
 * encrypted on-disk store. With a key configured for the harness's provider,
 * a prompt streams tokens; without one, the turn streams back an error frame
 * (surfaced in the UI) rather than tokens.
 */
async function main(): Promise<void> {
  const harnessPath = process.env.OH_HARNESS_PATH ?? process.argv[2];
  if (!harnessPath) {
    console.error("OH_HARNESS_PATH (or argv[2]) is required: path to a harness definition dir");
    process.exit(2);
  }

  const def = await loadHarnessDefinition(harnessPath);
  const profile = process.env.OH_PROFILE ?? def.manifest.providers.default.credentialProfile;

  const { manager, registry } = await loadAccounts({ profileName: profile });

  const handle = await startSidecar({
    harnessPath,
    manager,
    registry,
    profile,
    ...(process.env.OH_CWD ? { cwd: process.env.OH_CWD } : {}),
  });

  // Handshake line the Rust shell parses. Written last so any resource-loader
  // chatter above it is skipped by the line-scanning parser on the Rust side.
  process.stdout.write(`${JSON.stringify({ port: handle.port, token: handle.token })}\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    handle
      .close()
      .catch((err: unknown) => console.error(String((err as Error)?.message ?? err)))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // If the parent (the Rust shell) goes away, stdin closes — take that as a stop.
  process.stdin.on("end", shutdown);
  process.stdin.resume();
}

main().catch((e: unknown) => {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
});
