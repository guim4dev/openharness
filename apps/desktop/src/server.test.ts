import { afterEach, beforeEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, readFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateKeypair, bundleDefinition, writeBundle } from "@openharness/bundle";

/**
 * Tests `apps/desktop/src/server.ts`'s ENV -> `verified.minVersion` WIRING,
 * end to end, by spawning the real `server.ts` entry (the same way the Tauri
 * shell / `npm run sidecar` does — via `tsx`, since it imports other `.ts`
 * files) rather than calling `createLiveSession({ verified: { minVersion } })`
 * directly. `packages/core/src/verify-boot.test.ts` already proves the
 * anti-rollback floor works when `minVersion` is passed programmatically;
 * this file proves the OTHER half — that `server.ts` actually reads
 * `OH_MIN_VERSION` from the environment (as the Rust shell injects it from the
 * sealed `min-version.txt` build resource, see server.ts's docstring) and
 * threads it into that same `verified.minVersion` field.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const exampleHarness = join(repoRoot, "harnesses", "example");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const serverEntry = join(here, "server.ts");

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oh-server-env-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Sign harnesses/example (version 0.1.0); return paths to the bundle + org pubkey. */
function signExample(): { bundlePath: string; pubkeyPath: string } {
  const { publicKey, privateKey } = generateKeypair();
  const bundle = bundleDefinition(exampleHarness, privateKey);
  const bundlePath = join(tmp, "example.ohbundle");
  writeBundle(bundle, bundlePath);
  const pubkeyPath = join(tmp, "org.pub.pem");
  writeFileSync(pubkeyPath, publicKey);
  return { bundlePath, pubkeyPath };
}

interface Handshake {
  port: number;
  token: string;
}

/**
 * Spawn `server.ts` (via tsx, exactly like `apps/desktop`'s own `npm run
 * sidecar` script) with the given extra env, and resolve with the first JSON
 * handshake line it prints on stdout plus a `kill()` to tear it down. Never
 * touches the real machine's account store: `XDG_CONFIG_HOME` is pinned into
 * the test's own tmp dir.
 */
function bootServerTs(
  extraEnv: Record<string, string>,
): Promise<{ handshake: Handshake; kill: () => void }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, serverEntry], {
      cwd: tmp,
      env: {
        ...process.env,
        // Hermetic: OPENHARNESS_DIR is the full, cross-platform config-dir
        // override (configDir() honors it on every OS; XDG_CONFIG_HOME is only
        // consulted on Linux, so on macOS the child would otherwise read/write
        // the real ~/Library config). Clear ALL provider keys so the child's
        // loadAccounts resolves NO account (the onboarding path needs that).
        OPENHARNESS_DIR: join(tmp, "config"),
        XDG_CONFIG_HOME: join(tmp, "config"),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        OPENCODE_GO_API_KEY: "",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("timed out waiting for the sidecar handshake"));
      // Very generous: this spawns a real node+tsx child that transpiles the
      // sidecar's whole import graph on startup (20-35s even in isolation on a
      // busy machine). Under the full suite's parallelism those child processes
      // are CPU-starved by the worker threads, so the floor must clear heavy
      // contention, not just a cold start. CI (few cores, low parallelism) is
      // comfortably under this; the margin is for loaded local dev machines.
    }, 150_000);
    child.stdout.on("data", (d: Buffer) => {
      if (settled) return;
      buf += d.toString();
      for (const line of buf.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const h = JSON.parse(t) as { port?: unknown; token?: unknown };
          if (typeof h.port === "number" && typeof h.token === "string") {
            settled = true;
            clearTimeout(timer);
            resolvePromise({
              handshake: { port: h.port, token: h.token },
              kill: () => child.kill("SIGTERM"),
            });
            return;
          }
        } catch {
          /* non-JSON chatter (resource-loader logs etc.); keep scanning */
        }
      }
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server.ts exited before printing a handshake (code ${code})`));
    });
  });
}

function readData(data: unknown): string {
  return typeof data === "string" ? data : String(data);
}

interface Frame {
  type: string;
  error?: string;
}

/**
 * Connect, and on the first `needs_setup` submit `secret`; resolve with every
 * frame seen once `ready` arrives (or after `windowMs` if it never does). Proves
 * the REAL server.ts wiring end to end — including that it threads the
 * `secretStore` from `loadAccounts` into the sidecar (without it, set_credential
 * can never resolve to `ready`).
 */
function driveOnboardingViaServer(url: string, secret: string, windowMs: number): Promise<Frame[]> {
  return new Promise((resolvePromise, reject) => {
    const frames: Frame[] = [];
    const socket = new WebSocket(url);
    let sent = false;
    const done = setTimeout(() => {
      socket.close();
      resolvePromise(frames);
    }, windowMs);
    socket.onmessage = (event) => {
      const frame = JSON.parse(readData(event.data)) as Frame;
      frames.push(frame);
      if (frame.type === "needs_setup" && !sent) {
        sent = true;
        socket.send(JSON.stringify({ type: "set_credential", secret }));
      } else if (frame.type === "ready") {
        clearTimeout(done);
        socket.close();
        resolvePromise(frames);
      }
    };
    socket.onerror = () => {
      clearTimeout(done);
      reject(new Error("websocket error during onboarding"));
    };
  });
}

/** Connect, send a prompt, collect every frame for `windowMs`, then resolve. */
function collectFrames(url: string, windowMs: number): Promise<Frame[]> {
  return new Promise((resolvePromise, reject) => {
    const frames: Frame[] = [];
    const socket = new WebSocket(url);
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "prompt", text: "hello" }));
      setTimeout(() => {
        socket.close();
        resolvePromise(frames);
      }, windowMs);
    };
    socket.onmessage = (event) => frames.push(JSON.parse(readData(event.data)) as Frame);
    socket.onerror = () => reject(new Error("websocket error"));
  });
}

test(
  "OH_MIN_VERSION reaches verified.minVersion through server.ts: a validly-signed but OLDER bundle is refused end-to-end",
  async () => {
    // harnesses/example is version 0.1.0; a floor of 0.2.0 (set only via the
    // env var server.ts parses) must make it stale even though its signature
    // is perfectly valid.
    const { bundlePath, pubkeyPath } = signExample();
    const { handshake, kill } = await bootServerTs({
      OH_BUNDLE_PATH: bundlePath,
      OH_ORG_PUBKEY_PATH: pubkeyPath,
      OH_MIN_VERSION: "0.2.0",
    });
    try {
      const url = `ws://127.0.0.1:${handshake.port}?token=${encodeURIComponent(handshake.token)}`;
      const frames = await collectFrames(url, 1000);
      expect(frames.some((f) => f.type === "integrity_error")).toBe(true);
      // Proven: no session ever started under the stale floor.
      expect(frames.some((f) => f.type === "token")).toBe(false);
      expect(frames.some((f) => f.type === "done")).toBe(false);
    } finally {
      kill();
    }
  },
  210_000,
);

test(
  "resolvePinnedBundle at boot: a newer signed update in the updates dir is booted over the baked bundle",
  async () => {
    // Sign the example at TWO versions with ONE org key: baked 0.1.0 + a pulled
    // update 0.3.0 dropped into <configDir>/updates (where `openharness update`
    // writes). With OH_MIN_VERSION=0.3.0, booting the baked 0.1.0 would be an
    // integrity refusal — so a clean boot PROVES server.ts resolved + booted the
    // 0.3.0 update (i.e. resolvePinnedBundle is wired at boot, not dead code).
    const { publicKey, privateKey } = generateKeypair();
    const bakedPath = join(tmp, "baked.ohbundle");
    writeBundle(bundleDefinition(exampleHarness, privateKey), bakedPath); // 0.1.0
    const pubkeyPath = join(tmp, "org.pub.pem");
    writeFileSync(pubkeyPath, publicKey);

    const copy = join(tmp, "example-0.3.0");
    cpSync(exampleHarness, copy, { recursive: true });
    const hp = join(copy, "harness.json");
    const m = JSON.parse(readFileSync(hp, "utf8")) as { version: string };
    m.version = "0.3.0";
    writeFileSync(hp, JSON.stringify(m, null, 2));
    const updatesDir = join(tmp, "config", "updates");
    mkdirSync(updatesDir, { recursive: true });
    writeBundle(bundleDefinition(copy, privateKey), join(updatesDir, "example-0.3.0.ohbundle"));

    const { handshake, kill } = await bootServerTs({
      OH_BUNDLE_PATH: bakedPath,
      OH_ORG_PUBKEY_PATH: pubkeyPath,
      OH_MIN_VERSION: "0.3.0", // baked 0.1.0 alone would be refused; the update satisfies it
    });
    try {
      const url = `ws://127.0.0.1:${handshake.port}?token=${encodeURIComponent(handshake.token)}`;
      const frames = await collectFrames(url, 1000);
      expect(frames.some((f) => f.type === "integrity_error")).toBe(false); // 0.3.0 update booted
    } finally {
      kill();
    }
  },
  210_000,
);

test(
  "OH_MIN_VERSION AT/BELOW the bundle's version boots normally through server.ts (env-parsed floor is a lower bound, not exact-match)",
  async () => {
    const { bundlePath, pubkeyPath } = signExample();
    const { handshake, kill } = await bootServerTs({
      OH_BUNDLE_PATH: bundlePath,
      OH_ORG_PUBKEY_PATH: pubkeyPath,
      OH_MIN_VERSION: "0.1.0", // equal to the bundle's own version
    });
    try {
      const url = `ws://127.0.0.1:${handshake.port}?token=${encodeURIComponent(handshake.token)}`;
      const frames = await collectFrames(url, 1000);
      // No API key is configured, so the turn itself may error out — the point
      // here is only that verification passed (no integrity refusal).
      expect(frames.some((f) => f.type === "integrity_error")).toBe(false);
    } finally {
      kill();
    }
  },
  210_000,
);

test(
  "onboarding works through the REAL server.ts: no key -> needs_setup -> set_credential -> ready",
  async () => {
    // Dev boot with no env keys: loadAccounts resolves no account, so the sidecar
    // announces onboarding. This spawns the actual server.ts the Tauri shell runs,
    // so it regresses the wiring bug where server.ts dropped loadAccounts's
    // secretStore (set_credential would then never resolve to ready).
    const { handshake, kill } = await bootServerTs({ OH_HARNESS_PATH: exampleHarness });
    try {
      const url = `ws://127.0.0.1:${handshake.port}?token=${encodeURIComponent(handshake.token)}`;
      const frames = await driveOnboardingViaServer(url, "sk-user-pasted-key", 15_000);

      // Reached ready: the key was written to the (wired) local store and an
      // account resolved — not the "no local store is configured" dead end.
      expect(frames.some((f) => f.type === "ready")).toBe(true);
      const setupErrors = frames
        .filter((f) => f.type === "needs_setup")
        .map((f) => f.error)
        .filter(Boolean);
      expect(setupErrors).not.toContain("no local store is configured");
    } finally {
      kill();
    }
  },
  210_000,
);

test(
  "SEALED build refuses an unverified boot: OH_SEALED=1 + OH_HARNESS_PATH (no bundle) exits, never handshakes",
  async () => {
    // The desktop-boot review's HIGH: a preset empty OH_BUNDLE_PATH could downgrade
    // release to an unverified OH_HARNESS_PATH boot. In a sealed build server.ts must
    // fail closed — so it exits (code 2) rather than printing a handshake.
    await expect(bootServerTs({ OH_SEALED: "1", OH_HARNESS_PATH: exampleHarness })).rejects.toThrow(
      /exited before printing a handshake \(code 2\)/,
    );
  },
  120_000,
);
