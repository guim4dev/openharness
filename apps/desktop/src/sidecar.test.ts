import { afterEach, beforeEach, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  AuthProviderRegistry,
  CredentialManager,
  InMemorySecretStore,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";
import { createStubModelRegistry } from "@openharness/core";
import { startSidecar } from "./sidecar.ts";
import type { SidecarHandle } from "./sidecar.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleHarness = join(here, "..", "..", "..", "harnesses", "example");
const REPLY = "canned reply from stub";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oh-sidecar-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function startStubSidecar(): Promise<SidecarHandle> {
  const store = new InMemorySecretStore();
  await store.set("api-key:a", "key-a");
  const accounts: Account[] = [
    {
      id: "a",
      authProviderId: "api-key",
      label: "a",
      credential: { kind: "api_key", secretRef: "api-key:a" },
      health: { state: "ok" },
    },
  ];
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["a"] }];
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));

  return startSidecar({
    harnessPath: exampleHarness,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    modelRegistryOverride: createStubModelRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      reply: REPLY,
    }),
  });
}

interface Frame {
  type: string;
  text?: string;
  message?: string;
}

function readData(data: unknown): string {
  return typeof data === "string" ? data : String(data);
}

/** Connect with the URL, send a prompt, collect frames until done/error. */
function drivePrompt(url: string, text: string): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for done"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "prompt", text }));
    socket.onmessage = (event) => {
      const frame = JSON.parse(readData(event.data)) as Frame;
      frames.push(frame);
      if (frame.type === "done" || frame.type === "error") {
        clearTimeout(timer);
        socket.close();
        resolve(frames);
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("websocket error before completion"));
    };
  });
}

/** Resolve whether the upgrade was accepted (onopen) or rejected (onerror/close). */
function tryConnect(url: string): Promise<"accepted" | "rejected"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    let settled = false;
    const done = (r: "accepted" | "rejected") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done("rejected"), 10_000);
    socket.onopen = () => done("accepted");
    socket.onerror = () => done("rejected");
    socket.onclose = (event) => done(event.code === 1000 ? "accepted" : "rejected");
  });
}

test("streams token frames then a done frame over the loopback WS with a valid token", async () => {
  const sidecar = await startStubSidecar();
  try {
    const url = `ws://127.0.0.1:${sidecar.port}?token=${encodeURIComponent(sidecar.token)}`;
    const frames = await drivePrompt(url, "hello");

    const tokens = frames.filter((f) => f.type === "token").map((f) => f.text ?? "");
    expect(tokens.length).toBeGreaterThan(1); // streamed, not a single blob
    expect(tokens.join("")).toContain(REPLY);

    expect(frames.some((f) => f.type === "error")).toBe(false);
    expect(frames.at(-1)?.type).toBe("done");
  } finally {
    await sidecar.close();
  }
});

test("rejects a connection that omits the token", async () => {
  const sidecar = await startStubSidecar();
  try {
    const accepted = await tryConnect(`ws://127.0.0.1:${sidecar.port}`);
    expect(accepted).toBe("rejected");

    // Sanity: the same server accepts the correct token.
    const withToken = await tryConnect(
      `ws://127.0.0.1:${sidecar.port}?token=${encodeURIComponent(sidecar.token)}`,
    );
    expect(withToken).toBe("accepted");
  } finally {
    await sidecar.close();
  }
});
