import { afterEach, beforeEach, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  AuthProviderRegistry,
  CredentialManager,
  InMemorySecretStore,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";
import { createStubModelRegistry, createToolCallingStubModelRegistry } from "@openharness/core";
import type { Policy } from "@openharness/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateKeypair, bundleDefinition, writeBundle } from "@openharness/bundle";
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

async function buildStubCredentials(): Promise<{
  manager: CredentialManager;
  registry: AuthProviderRegistry;
}> {
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
  return { manager, registry };
}

function stubRegistry() {
  return createStubModelRegistry({
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    reply: REPLY,
  });
}

async function startStubSidecar(): Promise<SidecarHandle> {
  const { manager, registry } = await buildStubCredentials();
  return startSidecar({
    harnessPath: exampleHarness,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    modelRegistryOverride: stubRegistry(),
  });
}

/** Boot a sidecar pinned to a signed bundle at `bundlePath`, verified under `pubkeyPath`. */
async function startVerifiedSidecar(bundlePath: string, pubkeyPath: string): Promise<SidecarHandle> {
  const { manager, registry } = await buildStubCredentials();
  return startSidecar({
    verified: { bundlePath, pubkeyPath },
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    modelRegistryOverride: stubRegistry(),
  });
}

/** Sign the example harness; return paths to the written bundle + org pubkey. */
function signExample(mutate?: (bundle: ReturnType<typeof bundleDefinition>) => void): {
  bundlePath: string;
  pubkeyPath: string;
} {
  const { publicKey, privateKey } = generateKeypair();
  const bundle = bundleDefinition(exampleHarness, privateKey);
  mutate?.(bundle);
  const bundlePath = join(tmp, "example.ohbundle");
  writeBundle(bundle, bundlePath);
  const pubkeyPath = join(tmp, "org.pub.pem");
  writeFileSync(pubkeyPath, publicKey);
  return { bundlePath, pubkeyPath };
}

interface Frame {
  type: string;
  text?: string;
  message?: string;
  id?: string;
  toolName?: string;
  reason?: string;
}

interface ToolRecord {
  calls: number;
}

/** A tool whose body increments `record.calls` — so a test can prove it ran (or didn't). */
function makeCountingTool(record: ToolRecord): ToolDefinition {
  return {
    name: "danger_tool",
    label: "danger_tool",
    description: "A tool gated behind a policy ask.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    } as unknown as ToolDefinition["parameters"],
    async execute() {
      record.calls++;
      return { content: [{ type: "text", text: "tool ran" }], details: undefined };
    },
  } as ToolDefinition;
}

/**
 * Start a sidecar whose stubbed model calls `danger_tool` on its first turn,
 * gated behind a policy `ask`. Returns the handle plus the tool's call record so
 * a test can assert whether approval actually let the tool body run.
 */
async function startAskSidecar(opts: { askTimeoutMs?: number }): Promise<{
  sidecar: SidecarHandle;
  record: ToolRecord;
}> {
  const { manager, registry } = await buildStubCredentials();
  const record: ToolRecord = { calls: 0 };
  const policy: Policy = {
    default: "allow",
    rules: [{ match: "danger_tool", action: "ask", reason: "danger_tool needs approval" }],
  };
  const sidecar = await startSidecar({
    harnessPath: exampleHarness,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    policy,
    customTools: [makeCountingTool(record)],
    ...(opts.askTimeoutMs !== undefined ? { askTimeoutMs: opts.askTimeoutMs } : {}),
    modelRegistryOverride: createToolCallingStubModelRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      toolName: "danger_tool",
      toolArgs: {},
      finalReply: "all done",
    }),
  });
  return { sidecar, record };
}

/**
 * Connect, send a prompt, and answer the FIRST `ask` frame with `approved`.
 * Collect frames until done/error.
 */
function driveWithAskAnswer(url: string, text: string, approved: boolean): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const socket = new WebSocket(url);
    let answered = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for done"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "prompt", text }));
    socket.onmessage = (event) => {
      const frame = JSON.parse(readData(event.data)) as Frame;
      frames.push(frame);
      if (frame.type === "ask" && !answered) {
        answered = true;
        socket.send(JSON.stringify({ type: "ask_response", id: frame.id, approved }));
      }
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

/** Connect, send a prompt, and IGNORE the ask (never answer). Resolve on done/error. */
function driveIgnoringAsk(url: string, text: string): Promise<Frame[]> {
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

/** Connect, send a prompt, and CLOSE the socket the moment the ask arrives. */
function driveClosingOnAsk(url: string, text: string): Promise<{ askSeen: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for the ask frame"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "prompt", text }));
    socket.onmessage = (event) => {
      const frame = JSON.parse(readData(event.data)) as Frame;
      if (frame.type === "ask") {
        clearTimeout(timer);
        socket.close(); // disconnect before answering -> must fail closed
        resolve({ askSeen: true });
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("websocket error before the ask"));
    };
  });
}

/** Send a single client frame and resolve with the first server frame that comes back. */
function sendAndAwaitOneFrame(url: string, message: unknown): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for a reply frame"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify(message));
    socket.onmessage = (event) => {
      clearTimeout(timer);
      const frame = JSON.parse(readData(event.data)) as Frame;
      socket.close();
      resolve(frame);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    };
  });
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

/**
 * Connect, send a prompt, and give the sidecar a window to (wrongly) stream a
 * session before concluding. Resolves with every frame seen plus whether the
 * socket is still open — for proving the refusal path never produces token/done
 * and never drops the connection.
 */
function driveRefusal(url: string, text: string): Promise<{ frames: Frame[]; stillOpen: boolean }> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const socket = new WebSocket(url);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for the integrity refusal"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "prompt", text }));
    socket.onmessage = (event) => {
      frames.push(JSON.parse(readData(event.data)) as Frame);
      // On the first frame, poke the sidecar with another prompt and then wait a
      // beat: if a real session existed, token/done would arrive in this window.
      if (!settle) {
        socket.send(JSON.stringify({ type: "prompt", text: "again" }));
        settle = setTimeout(() => {
          clearTimeout(timer);
          const stillOpen = socket.readyState === socket.OPEN;
          socket.close();
          resolve({ frames, stillOpen });
        }, 400);
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      if (settle) clearTimeout(settle);
      reject(new Error("websocket error during refusal"));
    };
  });
}

test("boots normally on a VALID signed bundle: streams tokens then done, no integrity_error", async () => {
  const { bundlePath, pubkeyPath } = signExample();
  const sidecar = await startVerifiedSidecar(bundlePath, pubkeyPath);
  try {
    const url = `ws://127.0.0.1:${sidecar.port}?token=${encodeURIComponent(sidecar.token)}`;
    const frames = await drivePrompt(url, "hello");

    const tokens = frames.filter((f) => f.type === "token").map((f) => f.text ?? "");
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join("")).toContain(REPLY);
    expect(frames.some((f) => f.type === "integrity_error")).toBe(false);
    expect(frames.at(-1)?.type).toBe("done");
  } finally {
    await sidecar.close();
  }
});

test("refuses to boot a TAMPERED bundle: emits integrity_error, never token/done, keeps the socket open", async () => {
  const { bundlePath, pubkeyPath } = signExample((bundle) => {
    // Edit a bundled file after signing — signature + hash no longer match.
    bundle.manifest.files["system-prompt.md"].contentB64 =
      Buffer.from("tampered system prompt").toString("base64");
  });
  const sidecar = await startVerifiedSidecar(bundlePath, pubkeyPath);
  try {
    const url = `ws://127.0.0.1:${sidecar.port}?token=${encodeURIComponent(sidecar.token)}`;
    const { frames, stillOpen } = await driveRefusal(url, "hello");

    expect(frames.some((f) => f.type === "integrity_error")).toBe(true);
    // Proven: no session ever started, so no token/done frames follow.
    expect(frames.some((f) => f.type === "token")).toBe(false);
    expect(frames.some((f) => f.type === "done")).toBe(false);
    // A designed refusal keeps the connection alive (not a dead/dropped socket).
    expect(stillOpen).toBe(true);
  } finally {
    await sidecar.close();
  }
});

test("policy ask: emits an ask frame, and approving it lets the tool run", async () => {
  const { sidecar, record } = await startAskSidecar({});
  try {
    const url = `ws://127.0.0.1:${sidecar.port}?token=${encodeURIComponent(sidecar.token)}`;
    const frames = await driveWithAskAnswer(url, "do the dangerous thing", true);

    const ask = frames.find((f) => f.type === "ask");
    expect(ask).toBeDefined();
    expect(ask?.toolName).toBe("danger_tool");
    expect(ask?.reason).toBe("danger_tool needs approval");
    expect(typeof ask?.id).toBe("string");

    expect(record.calls).toBe(1); // approved -> the tool body ran
    expect(frames.at(-1)?.type).toBe("done");
  } finally {
    await sidecar.close();
  }
});

test("policy ask: denying it blocks the tool but the turn still settles", async () => {
  const { sidecar, record } = await startAskSidecar({});
  try {
    const url = `ws://127.0.0.1:${sidecar.port}?token=${encodeURIComponent(sidecar.token)}`;
    const frames = await driveWithAskAnswer(url, "do the dangerous thing", false);

    expect(frames.some((f) => f.type === "ask")).toBe(true);
    expect(record.calls).toBe(0); // denied -> the tool never ran
    expect(frames.at(-1)?.type).toBe("done");
  } finally {
    await sidecar.close();
  }
});

test("policy ask fails closed on timeout: no answer within askTimeoutMs denies the tool", async () => {
  const { sidecar, record } = await startAskSidecar({ askTimeoutMs: 200 });
  try {
    const url = `ws://127.0.0.1:${sidecar.port}?token=${encodeURIComponent(sidecar.token)}`;
    const frames = await driveIgnoringAsk(url, "do the dangerous thing");

    expect(frames.some((f) => f.type === "ask")).toBe(true);
    expect(record.calls).toBe(0); // timed out -> fail closed
    expect(frames.at(-1)?.type).toBe("done"); // the turn still settles
  } finally {
    await sidecar.close();
  }
});

test("policy ask fails closed on disconnect: closing before answering denies the tool", async () => {
  const { sidecar, record } = await startAskSidecar({});
  try {
    const url = `ws://127.0.0.1:${sidecar.port}?token=${encodeURIComponent(sidecar.token)}`;
    const { askSeen } = await driveClosingOnAsk(url, "do the dangerous thing");
    expect(askSeen).toBe(true);

    // Give the server a beat to finish the (now-orphaned) turn; the tool must
    // never have run because the only approver disconnected.
    await new Promise((r) => setTimeout(r, 400));
    expect(record.calls).toBe(0);
  } finally {
    await sidecar.close();
  }
});

test("policy ask: an ask_response with no matching pending ask is rejected", async () => {
  const sidecar = await startStubSidecar();
  try {
    const url = `ws://127.0.0.1:${sidecar.port}?token=${encodeURIComponent(sidecar.token)}`;
    const frame = await sendAndAwaitOneFrame(url, {
      type: "ask_response",
      id: "no-such-id",
      approved: true,
    });
    expect(frame.type).toBe("error");
    expect(frame.message).toContain("no pending approval");
  } finally {
    await sidecar.close();
  }
});
