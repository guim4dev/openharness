#!/usr/bin/env node
import { loadAccounts } from "@openharness/core";
import { loadHarnessDefinition } from "@openharness/definition";
import { startSidecar } from "./sidecar.ts";
import type { StartSidecarOptions } from "./sidecar.ts";

/**
 * Runnable sidecar entry. The Tauri (Rust) shell spawns this with `node`, reads
 * a single JSON handshake line from stdout — `{"port":<n>,"token":"<t>"}` — and
 * injects it into the webview as `window.__OPENHARNESS__` so the UI can open the
 * loopback WebSocket. Keep the handshake the FIRST parseable JSON object printed
 * to stdout; the Rust side scans lines and takes the first that parses.
 *
 * Boot source (pick one):
 *   Verified boot (production trust path) — set BOTH:
 *     OH_BUNDLE_PATH      path to a signed `.ohbundle`
 *     OH_ORG_PUBKEY_PATH  path to the org's public key (PEM) the bundle must verify under
 *   The sidecar boots pinned to the verified definition; if the bundle is
 *   unsigned/tampered/signed by the wrong key, it comes up in refusal mode and
 *   the UI is locked (see sidecar `integrity_error`).
 *
 *   Dev boot (unverified local dir) — used when the pair above is absent:
 *     OH_HARNESS_PATH     path to a harness definition dir (else argv[2])
 *
 * Other config (env, optional):
 *   OH_PROFILE   credential profile to drive. Dev: defaults to the harness's
 *                declared profile. Verified: the definition is only trusted
 *                AFTER verification (done inside the sidecar), so the profile is
 *                an explicit operator choice here, defaulting to "default".
 *   OH_CWD       working directory for the Pi session (else process.cwd())
 *
 * Credentials: bring-your-own-key via loadAccounts — env keys
 * (ANTHROPIC_API_KEY etc.) plus configDir()/accounts.json, secrets in the
 * encrypted on-disk store. With a key configured for the harness's provider,
 * a prompt streams tokens; without one, the turn streams back an error frame
 * (surfaced in the UI) rather than tokens.
 */
async function main(): Promise<void> {
  const bundlePath = process.env.OH_BUNDLE_PATH;
  const pubkeyPath = process.env.OH_ORG_PUBKEY_PATH;
  const verified = bundlePath && pubkeyPath ? { bundlePath, pubkeyPath } : undefined;
  const harnessPath = process.env.OH_HARNESS_PATH ?? process.argv[2];

  if (!verified && !harnessPath) {
    console.error(
      "No boot source configured. Set OH_BUNDLE_PATH + OH_ORG_PUBKEY_PATH for a verified boot, " +
        "or OH_HARNESS_PATH (or argv[2]) for a local dev boot.",
    );
    process.exit(2);
  }

  // Resolve the credential profile without trusting an unverified bundle: in
  // dev we read it off the harness on disk; in verified mode it is an operator
  // choice via OH_PROFILE (the bundle is verified later, inside the sidecar).
  let profile: string;
  if (verified) {
    profile = process.env.OH_PROFILE ?? "default";
  } else {
    const def = await loadHarnessDefinition(harnessPath as string);
    profile = process.env.OH_PROFILE ?? def.manifest.providers.default.credentialProfile;
  }

  const { manager, registry } = await loadAccounts({ profileName: profile });

  const opts: StartSidecarOptions = {
    manager,
    registry,
    profile,
    ...(verified ? { verified } : { harnessPath: harnessPath as string }),
    ...(process.env.OH_CWD ? { cwd: process.env.OH_CWD } : {}),
  };

  const handle = await startSidecar(opts);

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
