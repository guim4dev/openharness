import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { createLiveSession } from "@openharness/core";
import type { CreateLiveSessionOptions, LiveSession } from "@openharness/core";
import { BundleVerificationError } from "@openharness/bundle";

/** Frames the client sends to the sidecar. */
export type ClientMessage = { type: "prompt"; text: string };

/** Frames the sidecar streams back to the client. */
export type ServerMessage =
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string }
  /**
   * Verify-on-boot refusal: the harness definition could not be verified
   * (unsigned, tampered, or signed by the wrong key). No session exists; this
   * frame is the whole conversation. Distinct from `error`, which is a failure
   * WITHIN an otherwise-trusted session.
   */
  | { type: "integrity_error"; message: string };

export interface SidecarHandle {
  /** Ephemeral loopback port the WS server is listening on. */
  port: number;
  /** Ephemeral secret; clients must present it as `?token=` to connect. */
  token: string;
  /** Stop the server and dispose the underlying Pi session. */
  close(): Promise<void>;
}

/** Inputs for the sidecar: everything `createLiveSession` needs. */
export type StartSidecarOptions = CreateLiveSessionOptions;

function isClientMessage(value: unknown): value is ClientMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "prompt" &&
    typeof (value as { text?: unknown }).text === "string"
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
 *   server -> client: { type: "token", text }  (per streamed assistant delta)
 *                     { type: "done" }          (turn settled)
 *                     { type: "error", message }
 *
 * Prompts are serialized per sidecar so runs never overlap (an overlapping run
 * would require Pi's streamingBehavior); each turn awaits settlement first.
 *
 * Verify-on-boot: when `opts.verified` points at a signed bundle whose signature
 * does not validate (unsigned / tampered / wrong key), `createLiveSession`
 * throws a `BundleVerificationError`. Rather than crash the sidecar (a dead
 * socket looks like a bug), we come up in a REFUSAL mode: the WS server still
 * listens and accepts the authenticated client, but it announces a single
 * `integrity_error` frame and runs no session. A designed refusal, not silence.
 */
export async function startSidecar(opts: StartSidecarOptions): Promise<SidecarHandle> {
  const token = randomBytes(32).toString("base64url");

  // Boot the session. If verification fails, hold the reason and enter refusal
  // mode instead of propagating (so the UI can render a designed lock screen).
  let live: LiveSession | undefined;
  let integrityError: string | undefined;
  try {
    live = await createLiveSession(opts);
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
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", message: "invalid JSON" });
        return;
      }
      if (!isClientMessage(parsed)) {
        send(socket, { type: "error", message: "unsupported message" });
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
