import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { configDir, createLiveSession } from "@openharness/core";
import type { CreateLiveSessionOptions, LiveSession } from "@openharness/core";
import { BundleVerificationError } from "@openharness/bundle";

/** Frames the client sends to the sidecar. */
export type ClientMessage =
  | { type: "prompt"; text: string }
  /**
   * The client's answer to a server `ask` frame (a policy `ask` decision). The
   * `id` correlates back to the outstanding `ask`; `approved` is the human's
   * decision. An answer with no matching pending ask is rejected.
   */
  | { type: "ask_response"; id: string; approved: boolean }
  /**
   * A credential the user provided during onboarding. Written to the
   * machine-local encrypted store and registered on the manager for the
   * harness's provider; the sidecar then replies `ready` or `needs_setup`.
   */
  | { type: "set_credential"; secret: string };

/** Frames the sidecar streams back to the client. */
export type ServerMessage =
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string }
  /**
   * A policy `ask` decision needs a human. The client must render an
   * approve/deny dialog and reply with a matching `ask_response`. The tool call
   * is suspended until the answer arrives (or a timeout/disconnect denies it).
   */
  | { type: "ask"; id: string; toolName: string; reason?: string }
  /**
   * An outstanding `ask` was finished WITHOUT a client answer (timeout or the
   * answering socket disconnected): the tool has already been denied
   * server-side. Sent so the client can drop the now-dead approval modal, which
   * would otherwise linger and later fire a stale (rejected) `ask_response`.
   */
  | { type: "ask_cancelled"; id: string; reason: string }
  /**
   * Verify-on-boot refusal: the harness definition could not be verified
   * (unsigned, tampered, or signed by the wrong key). No session exists; this
   * frame is the whole conversation. Distinct from `error`, which is a failure
   * WITHIN an otherwise-trusted session.
   */
  | { type: "integrity_error"; message: string }
  /**
   * No credential resolves for the harness's provider. RECOVERABLE: the client
   * shows an onboarding panel and replies with `set_credential`. `error` is set
   * when a just-submitted key was empty/unresolvable.
   */
  | { type: "needs_setup"; provider: string; profile: string; configPath: string; error?: string }
  /** A credential is now in place (after `set_credential`): chat is enabled. */
  | { type: "ready" };

export interface SidecarHandle {
  /** Ephemeral loopback port the WS server is listening on. */
  port: number;
  /** Ephemeral secret; clients must present it as `?token=` to connect. */
  token: string;
  /** Stop the server and dispose the underlying Pi session. */
  close(): Promise<void>;
}

/** Inputs for the sidecar: everything `createLiveSession` needs, plus WS knobs. */
export type StartSidecarOptions = CreateLiveSessionOptions & {
  /**
   * How long to wait for a client's `ask_response` before denying the tool call
   * (fail-closed). Default 60_000ms. A short value is used by tests.
   */
  askTimeoutMs?: number;
};

function isPromptMessage(value: unknown): value is Extract<ClientMessage, { type: "prompt" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "prompt" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function isAskResponse(value: unknown): value is Extract<ClientMessage, { type: "ask_response" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ask_response" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { approved?: unknown }).approved === "boolean"
  );
}

function isSetCredential(value: unknown): value is Extract<ClientMessage, { type: "set_credential" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set_credential" &&
    typeof (value as { secret?: unknown }).secret === "string"
  );
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * Loopback WebSocket bridge over a real Pi AgentSession. Binds to 127.0.0.1 on
 * an ephemeral port and gates every upgrade on an ephemeral token (rejected at
 * the HTTP upgrade with 401 when absent/wrong), so no unauthenticated local
 * listener is exposed.
 *
 * Protocol:
 *   client -> server: { type: "prompt", text }
 *                     { type: "ask_response", id, approved }
 *   server -> client: { type: "token", text }  (per streamed assistant delta)
 *                     { type: "done" }          (turn settled)
 *                     { type: "error", message }
 *                     { type: "ask", id, toolName, reason? }  (policy needs a human)
 *
 * Prompts are serialized per sidecar so runs never overlap (an overlapping run
 * would require Pi's streamingBehavior); each turn awaits settlement first.
 *
 * Policy `ask`: a policy `ask` decision suspends the tool call and emits an
 * `ask` frame to the connected client, resolving when a matching `ask_response`
 * arrives. It FAILS CLOSED (denies the tool) in every case where a human cannot
 * be reached: no client connected, no answer within `askTimeoutMs`, or the
 * socket closes first.
 *
 * Verify-on-boot: when `opts.verified` points at a signed bundle whose signature
 * does not validate (unsigned / tampered / wrong key), `createLiveSession`
 * throws a `BundleVerificationError`. Rather than crash the sidecar (a dead
 * socket looks like a bug), we come up in a REFUSAL mode: the WS server still
 * listens and accepts the authenticated client, but it announces a single
 * `integrity_error` frame and runs no session. A designed refusal, not silence.
 */
export async function startSidecar(opts: StartSidecarOptions): Promise<SidecarHandle> {
  const { askTimeoutMs = 60_000, ...sessionOpts } = opts;
  const token = randomBytes(32).toString("base64url");

  // The socket the ask dialog is shown on, and the asks awaiting an answer.
  // Both are read by the `askUser` closure below; `askUser` is built BEFORE the
  // session so it can be threaded into it, but only ever fires mid-turn — by
  // which point a client has connected and `currentSocket` is set.
  interface PendingAsk {
    socket: WebSocket;
    /**
     * Settle the ask. `cancelReason` (timeout/disconnect — i.e. NOT a client
     * answer) additionally emits an `ask_cancelled` frame so the client drops
     * its modal; a client answer passes no reason and emits nothing.
     */
    finish: (approved: boolean, cancelReason?: string) => void;
  }
  const pendingAsks = new Map<string, PendingAsk>();
  let currentSocket: WebSocket | undefined;

  /**
   * Resolve a policy `ask` by asking the connected client. Fail-closed: denies
   * (resolves false) when no client is connected, when no `ask_response` arrives
   * within `askTimeoutMs`, or when the socket closes before answering.
   */
  const askUser = (req: { toolName: string; reason?: string }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const socket = currentSocket;
      if (!socket || socket.readyState !== socket.OPEN) {
        resolve(false); // no one to approve -> deny
        return;
      }
      const id = randomBytes(16).toString("base64url");
      let settled = false;
      const finish = (approved: boolean, cancelReason?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingAsks.delete(id);
        // A server-side denial (timeout/disconnect) tells the client to drop the
        // modal; a client answer (no reason) needs no frame.
        if (cancelReason !== undefined) send(socket, { type: "ask_cancelled", id, reason: cancelReason });
        resolve(approved);
      };
      const timer = setTimeout(() => finish(false, "approval timed out"), askTimeoutMs);
      pendingAsks.set(id, { socket, finish });
      send(socket, {
        type: "ask",
        id,
        toolName: req.toolName,
        ...(req.reason ? { reason: req.reason } : {}),
      });
    });

  // Boot the session. If verification fails, hold the reason and enter refusal
  // mode instead of propagating (so the UI can render a designed lock screen).
  let live: LiveSession | undefined;
  let integrityError: string | undefined;
  try {
    live = await createLiveSession({ ...sessionOpts, askUser });
  } catch (err) {
    if (err instanceof BundleVerificationError) integrityError = err.message;
    else throw err;
  }

  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: ({ req }, done) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const ok = url.searchParams.get("token") === token;
      if (ok) done(true);
      else done(false, 401, "Unauthorized");
    },
  });

  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  // Serialize turns so we never issue prompt() while a run is active.
  let queue: Promise<void> = Promise.resolve();

  server.on("connection", (socket: WebSocket) => {
    // The ask dialog is shown on the most-recently-connected client.
    currentSocket = socket;
    // Fail-closed on disconnect: any ask awaiting THIS socket can no longer be
    // answered, so deny it. Snapshot first — `finish` mutates `pendingAsks`.
    socket.on("close", () => {
      if (currentSocket === socket) currentSocket = undefined;
      for (const pending of [...pendingAsks.values()]) {
        if (pending.socket === socket) pending.finish(false, "client disconnected");
      }
    });

    // Refusal mode: no session was created. Announce the integrity failure and
    // keep the connection open; any prompt is answered with the same frame, so
    // no `token`/`done` can ever follow. The app is locked until a valid signed
    // configuration is provided.
    if (integrityError !== undefined) {
      const message = integrityError;
      send(socket, { type: "integrity_error", message });
      socket.on("message", () => send(socket, { type: "integrity_error", message }));
      return;
    }

    // Normal mode: verification passed (or was not requested), so a session
    // exists. `integrityError === undefined` guarantees `live` is set.
    const session = live as LiveSession;

    // Onboarding: a turn needs a credential for the harness's provider. If none
    // resolves, announce `needs_setup` so the UI shows the panel; a
    // `set_credential` writes the key to the machine-local store and registers
    // it, then chat is enabled. providerId comes from the (verified) definition.
    const { manager, secretStore, profile } = sessionOpts;
    const providerId = session.providerId;
    const isReady = (): boolean => !!manager.activeAccount(profile, providerId);
    const needsSetup = (error?: string): ServerMessage => ({
      type: "needs_setup",
      provider: providerId,
      profile,
      configPath: configDir(),
      ...(error ? { error } : {}),
    });
    if (!isReady()) send(socket, needsSetup());

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", message: "invalid JSON" });
        return;
      }
      // A credential provided in the app during onboarding. Persist it to the
      // local encrypted store and register an account for the harness's provider,
      // then confirm readiness. The secret is never logged. A blank key or a
      // missing store fails closed (stays in setup).
      if (isSetCredential(parsed)) {
        const secret = parsed.secret.trim();
        if (!secret) return send(socket, needsSetup("that key was empty"));
        if (!secretStore) return send(socket, needsSetup("no local store is configured"));
        const id = `gui-${providerId}`;
        void secretStore
          .set(`api-key:${id}`, secret)
          .then(() => {
            manager.addAccount(
              {
                id,
                provider: providerId,
                authProviderId: "api-key",
                label: `${providerId} (in-app)`,
                credential: { kind: "api_key", secretRef: `api-key:${id}` },
                health: { state: "ok" },
              },
              profile,
            );
            if (isReady()) {
              // Broadcast: any other client that connected while unconfigured is
              // also waiting on the onboarding panel — release them all.
              for (const client of server.clients) send(client, { type: "ready" });
            } else {
              send(socket, needsSetup("could not resolve the key"));
            }
          })
          .catch(() => send(socket, needsSetup("failed to save the key")));
        return;
      }
      // A human's answer to an outstanding `ask`. Correlate by id; an answer
      // with no matching pending ask (already settled by timeout/disconnect,
      // duplicate, or stale) is a BENIGN NO-OP — never an error frame, which
      // would surface as a spurious error bubble in the UI for a modal the
      // server already cancelled.
      if (isAskResponse(parsed)) {
        const pending = pendingAsks.get(parsed.id);
        if (pending) pending.finish(parsed.approved);
        return;
      }
      if (!isPromptMessage(parsed)) {
        send(socket, { type: "error", message: "unsupported message" });
        return;
      }
      // Don't drive a turn with no credential — re-announce onboarding instead
      // of letting the provider request fail with a cryptic auth error.
      if (!isReady()) {
        send(socket, needsSetup());
        return;
      }
      const { text } = parsed;
      queue = queue.then(async () => {
        try {
          await session.prompt(text, (event) => {
            if (event.type === "token") send(socket, { type: "token", text: event.text });
            else if (event.type === "done") send(socket, { type: "done" });
            else send(socket, { type: "error", message: event.message });
          });
        } catch (err) {
          send(socket, { type: "error", message: (err as Error)?.message ?? String(err) });
        }
      });
    });
  });

  return {
    port,
    token,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        for (const client of server.clients) client.terminate();
      });
      await live?.close();
    },
  };
}
