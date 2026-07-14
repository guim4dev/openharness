import { afterEach, beforeEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
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
        XDG_CONFIG_HOME: join(tmp, "config"), // hermetic: never read/write the real machine's accounts
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
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
