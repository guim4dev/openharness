#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, loadAccounts, resolvePinnedBundle, maxVersion } from "@openharness/core";
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
 *   Optional anti-rollback floor:
 *     OH_MIN_VERSION      semver floor baked into the app at build time; a
 *                         validly-signed but OLDER bundle is refused on boot.
 *                         Absent => no floor (dev/no-floor still works).
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
  // Anti-rollback floor baked into the app at build time (main.rs sets it from
  // the sealed min-version.txt resource in release). When present, a validly-
  // signed but OLDER bundle is refused on boot. Optional: absent => no floor.
  const minVersion = process.env.OH_MIN_VERSION?.trim() || undefined;

  // Pick the bundle to boot: the newest bundle that verifies under the org key
  // at the anti-rollback floor — the baked-in one, OR a newer signed update
  // pulled by `openharness update` into the updates dir. Without this the pulled
  // update never takes effect and the persisted floor defends nothing at boot.
  // A rollback/tampered candidate is refused; if nothing resolves (e.g. the baked
  // bundle itself doesn't verify), fall back to the baked path so the sidecar
  // fails loud with the precise reason instead of here.
  let bootBundlePath = bundlePath;
  // The floor the sidecar (stage 2) re-verifies at MUST be at least the effective
  // floor stage-1 selection used — otherwise a swapped org-signed bundle in
  // [baked, effectiveFloor) could pass the sidecar's weaker baked-only check.
  // Stricter wins: start at the baked OH_MIN_VERSION, raise to the resolved floor.
  let sidecarMinVersion = minVersion;
  if (bundlePath && pubkeyPath) {
    const updatesDir = process.env.OH_UPDATES_DIR ?? join(configDir(), "updates");
    const floorPath = process.env.OH_FLOOR_PATH ?? join(configDir(), "version-floor.txt");
    try {
      const resolved = resolvePinnedBundle({
        bakedBundlePath: bundlePath,
        updatesDir,
        pubkeyPem: readFileSync(pubkeyPath, "utf8"),
        floorPath,
      });
      bootBundlePath = resolved.path;
      sidecarMinVersion = minVersion ? maxVersion(minVersion, resolved.floor) : resolved.floor;
    } catch {
      bootBundlePath = bundlePath;
    }
  }

  const verified =
    bundlePath && pubkeyPath
      ? { bundlePath: bootBundlePath as string, pubkeyPath, ...(sidecarMinVersion ? { minVersion: sidecarMinVersion } : {}) }
      : undefined;
  const harnessPath = process.env.OH_HARNESS_PATH ?? process.argv[2];

  // A half-configured verified boot must FAIL LOUD — never silently fall back to
  // an unverified dev boot (this is a trust product). If exactly one of the two
  // verified-path env vars is set, refuse rather than boot unverified.
  if (Boolean(bundlePath) !== Boolean(pubkeyPath)) {
    console.error(
      "Incomplete verified-boot config: set BOTH OH_BUNDLE_PATH and OH_ORG_PUBKEY_PATH " +
        "(refusing to fall back to an unverified boot).",
    );
    process.exit(2);
  }

  // Defense in depth (belt to main.rs's env-sealing suspenders): a SEALED build
  // — the launcher sets OH_SEALED=1 in release and pins the verified inputs — must
  // NEVER take an unverified/dev boot, whatever the environment says. If we reach
  // here sealed without a verified bundle (e.g. a preset OH_BUNDLE_PATH="" trying
  // to downgrade to an OH_HARNESS_PATH boot), refuse rather than load unsigned config.
  if (process.env.OH_SEALED === "1" && !verified) {
    console.error(
      "Sealed build: refusing an unverified boot — a verified bundle (OH_BUNDLE_PATH + OH_ORG_PUBKEY_PATH) is required.",
    );
    process.exit(2);
  }

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

  const { manager, registry, secretStore } = await loadAccounts({ profileName: profile });

  const opts: StartSidecarOptions = {
    manager,
    registry,
    secretStore, // REQUIRED for in-app onboarding: set_credential writes the key here.
    profile,
    onboardConfigDir: configDir(), // persist an onboarded key (keyless) so it survives restart
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
