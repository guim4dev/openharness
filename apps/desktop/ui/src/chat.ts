import { useCallback, useEffect, useReducer, useRef, useState } from "react";

/**
 * The frames the sidecar streams back over the loopback WebSocket. Mirrors the
 * server -> client half of the sidecar protocol; kept local so the UI package
 * has no dependency on the Node sidecar module.
 */
export type ServerMessage =
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string }
  /**
   * A policy `ask` decision needs a human. The UI must show an approve/deny
   * dialog and reply with a matching `ask_response`. Correlated by `id`.
   */
  | { type: "ask"; id: string; toolName: string; reason?: string }
  /**
   * The sidecar finished an `ask` WITHOUT our answer (timeout or disconnect):
   * the tool has already been denied server-side. The UI must drop this ask so
   * its modal cannot linger and later fire a stale (now-rejected) `ask_response`.
   */
  | { type: "ask_cancelled"; id: string; reason?: string }
  /**
   * Verify-on-boot refusal from the sidecar: the configuration could not be
   * cryptographically verified. Locks the UI — no chat is possible this session.
   */
  | { type: "integrity_error"; message: string }
  /**
   * No credential resolves for the harness's provider yet. A RECOVERABLE state:
   * the UI shows an onboarding panel and the user provides a key (via
   * `submitCredential`). `error` is set when a just-submitted key was rejected.
   */
  | { type: "needs_setup"; provider: string; profile: string; configPath: string; error?: string }
  /**
   * A credential is now in place (after `set_credential`): leave the onboarding
   * panel and enable chat. Sent by the sidecar once an account resolves.
   */
  | { type: "ready" }
  /**
   * Result of a visual-builder `save_definition`: the directory written, whether
   * `doctor` passed (`ok`), its `problems`, and an `error` on a write failure.
   */
  | { type: "definition_saved"; ok: boolean; dir: string; problems: SaveProblem[]; error?: string }
  /** The names of saved definitions (response to `list_definitions`). */
  | { type: "definitions_listed"; names: string[] }
  /** A saved definition's raw files to reopen in the builder (or an `error`). */
  | {
      type: "definition_loaded";
      name: string;
      manifest?: unknown;
      policy?: unknown;
      systemPrompt?: string;
      skills?: { path: string; content: string }[];
      error?: string;
    };

export interface LoadedDefinition {
  name: string;
  manifest: Record<string, unknown>;
  policy?: Record<string, unknown>;
  systemPrompt: string;
  /** Each declared skill's SKILL.md body (by path), for the builder to fold back in. */
  skills?: { path: string; content: string }[];
}

export interface SaveProblem {
  level: "error" | "warn";
  code: string;
  message: string;
}

export interface SaveResult {
  ok: boolean;
  dir: string;
  problems: SaveProblem[];
  error?: string;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** True while assistant tokens are still streaming into this message. */
  streaming: boolean;
  /** True when this message represents a delivery/agent error. */
  error: boolean;
}

export type ChatStatus = "idle" | "streaming" | "integrity_error" | "needs_setup";

/** An outstanding policy approval the user must answer before the tool runs. */
export interface PendingAsk {
  id: string;
  toolName: string;
  reason?: string;
}

/** Onboarding context shown when no credential resolves for the provider. */
export interface SetupState {
  provider: string;
  profile: string;
  configPath: string;
  /** Set when a just-submitted key was rejected, so the panel can explain. */
  error?: string;
}

export interface ChatState {
  messages: ChatMessage[];
  status: ChatStatus;
  /** Monotonic counter used to mint stable message ids without side effects. */
  seq: number;
  /**
   * Set only in the terminal `integrity_error` status: the human-readable
   * reason the configuration was refused. Drives the refusal screen.
   */
  integrityMessage?: string;
  /**
   * FIFO queue of policy `ask`s awaiting the user's decision. Only the head is
   * surfaced (one modal at a time); answering the head reveals the next. Kept as
   * a queue so a second concurrent ask never overwrites the first. Entries leave
   * the queue on `answer_ask` (head), `ask_cancelled` (any id, server denied it
   * out-of-band), or defensively on `done`.
   */
  pendingAsks: PendingAsk[];
  /**
   * Set only in the `needs_setup` status: the onboarding context (which provider
   * needs a key, where config lives, and any wrong-key error). Cleared on `ready`.
   */
  setup?: SetupState;
  /** The most recent visual-builder save outcome (from `definition_saved`). */
  saveResult?: SaveResult;
  /** Names of saved definitions the builder can reopen (from `definitions_listed`). */
  availableDefinitions?: string[];
  /** The definition most recently loaded for editing (from `definition_loaded`). */
  loadedDefinition?: LoadedDefinition;
}

export type ChatAction =
  | { type: "send"; text: string }
  | { type: "server"; event: ServerMessage }
  /** The user answered the pending ask; clear the modal (the answer goes over the WS). */
  | { type: "answer_ask"; id: string };

export const initialChatState: ChatState = {
  messages: [],
  status: "idle",
  seq: 0,
  pendingAsks: [],
};

function lastMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages[messages.length - 1];
}

/** Replace the final message in a list with `next`, without mutating the input. */
function replaceLast(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  return [...messages.slice(0, -1), next];
}

function applyServerEvent(state: ChatState, event: ServerMessage): ChatState {
  const last = lastMessage(state.messages);

  switch (event.type) {
    case "token": {
      // Accumulate deltas into the open assistant message if one is streaming;
      // otherwise open a fresh assistant message so a stream that arrives
      // without a preceding local `send` still lands in a single bubble.
      if (last && last.role === "assistant" && last.streaming) {
        return {
          ...state,
          status: "streaming",
          messages: replaceLast(state.messages, { ...last, text: last.text + event.text }),
        };
      }
      return {
        ...state,
        status: "streaming",
        seq: state.seq + 1,
        messages: [
          ...state.messages,
          {
            id: `a${state.seq}`,
            role: "assistant",
            text: event.text,
            streaming: true,
            error: false,
          },
        ],
      };
    }

    case "done": {
      // Defensive: a settled turn can have no live ask (asks block the turn),
      // so clear the queue so no modal can outlive its turn.
      if (last && last.role === "assistant" && last.streaming) {
        return {
          ...state,
          status: "idle",
          pendingAsks: [],
          messages: replaceLast(state.messages, { ...last, streaming: false }),
        };
      }
      return { ...state, status: "idle", pendingAsks: [] };
    }

    case "error": {
      // Turn the open assistant bubble (if any) into the error, otherwise add a
      // standalone error bubble. Either way the failure is surfaced to the user.
      // An error ends the turn, so (like `done`) clear the ask queue — a pending
      // approval must not outlive its turn as a stale ask.
      if (last && last.role === "assistant" && last.streaming) {
        return {
          ...state,
          status: "idle",
          pendingAsks: [],
          messages: replaceLast(state.messages, {
            ...last,
            streaming: false,
            error: true,
            text: event.message,
          }),
        };
      }
      return {
        ...state,
        status: "idle",
        pendingAsks: [],
        seq: state.seq + 1,
        messages: [
          ...state.messages,
          {
            id: `e${state.seq}`,
            role: "assistant",
            text: event.message,
            streaming: false,
            error: true,
          },
        ],
      };
    }

    case "ask": {
      // A tool call is suspended pending the user's approval. Enqueue it (one
      // modal surfaces at a time); the turn's status stays as-is. A duplicate id
      // never double-queues.
      if (state.pendingAsks.some((a) => a.id === event.id)) return state;
      return {
        ...state,
        pendingAsks: [
          ...state.pendingAsks,
          {
            id: event.id,
            toolName: event.toolName,
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          },
        ],
      };
    }

    case "ask_cancelled": {
      // The sidecar denied this ask out-of-band (timeout/disconnect). Drop it
      // from the queue wherever it sits so its modal cannot linger and later
      // fire a stale ask_response.
      return { ...state, pendingAsks: state.pendingAsks.filter((a) => a.id !== event.id) };
    }

    case "integrity_error": {
      // Terminal: the definition failed verification on boot. Lock the whole UI
      // into a dedicated refusal state — this overrides any in-flight stream and
      // no further chat is possible for this session.
      return { ...state, status: "integrity_error", integrityMessage: event.message };
    }

    case "needs_setup": {
      // Recoverable: no credential resolves yet. Show the onboarding panel.
      return {
        ...state,
        status: "needs_setup",
        setup: {
          provider: event.provider,
          profile: event.profile,
          configPath: event.configPath,
          ...(event.error !== undefined ? { error: event.error } : {}),
        },
      };
    }

    case "ready": {
      // A credential is now in place: leave onboarding, enable chat.
      return { ...state, status: "idle", setup: undefined };
    }

    case "definition_saved": {
      // A visual-builder save came back: record the outcome for the panel. Does
      // not touch chat status — authoring is orthogonal to the conversation.
      const { type: _t, ...result } = event;
      return { ...state, saveResult: result };
    }

    case "definitions_listed":
      return { ...state, availableDefinitions: event.names };

    case "definition_loaded": {
      // A saved definition's raw files came back for editing. Ignore an error
      // payload (the panel keeps its current draft); otherwise stash it for the
      // builder to fold in via draftFromManifest.
      if (event.error || !event.manifest) return state;
      return {
        ...state,
        loadedDefinition: {
          name: event.name,
          manifest: event.manifest as Record<string, unknown>,
          ...(event.policy ? { policy: event.policy as Record<string, unknown> } : {}),
          systemPrompt: event.systemPrompt ?? "",
          ...(event.skills ? { skills: event.skills } : {}),
        },
      };
    }
  }
}

/**
 * Pure state transition for the chat. `send` appends the user's message plus an
 * empty streaming assistant placeholder; `server` folds an incoming WS frame in.
 * No side effects — fully unit-testable.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "send":
      return {
        ...state,
        status: "streaming",
        seq: state.seq + 1,
        messages: [
          ...state.messages,
          { id: `u${state.seq}`, role: "user", text: action.text, streaming: false, error: false },
          { id: `a${state.seq}`, role: "assistant", text: "", streaming: true, error: false },
        ],
      };
    case "server":
      return applyServerEvent(state, action.event);
    case "answer_ask": {
      // Answer only the HEAD (the surfaced modal). A non-head id is a no-op, so
      // a stale answer can never dequeue the wrong ask. Removing the head
      // reveals the next queued ask.
      const head = state.pendingAsks[0];
      if (!head || head.id !== action.id) return state;
      return { ...state, pendingAsks: state.pendingAsks.slice(1) };
    }
  }
}

export interface Connection {
  port: number;
  token: string;
}

export interface UseChat {
  messages: ChatMessage[];
  status: ChatStatus;
  /** True once the WebSocket upgrade has completed. */
  connected: boolean;
  /** Send a prompt to the sidecar (no-op until connected). */
  send: (text: string) => void;
  /** Set only in the `integrity_error` status: why the configuration was refused. */
  integrityMessage?: string;
  /** The currently-surfaced policy `ask` (head of the queue), if any. Drives the modal. */
  pendingAsk?: PendingAsk;
  /**
   * Answer the surfaced ask: forwards `ask_response` to the sidecar and reveals
   * the next queued ask. No-ops if `id` is not the currently-surfaced ask.
   */
  answerAsk: (id: string, approved: boolean) => void;
  /** Set only in the `needs_setup` status: the onboarding context for the panel. */
  setup?: SetupState;
  /**
   * Submit a credential during onboarding: forwards `set_credential` to the
   * sidecar, which writes it to the local encrypted store and re-resolves. The
   * sidecar replies with `ready` (chat enabled) or `needs_setup` with an error.
   */
  submitCredential: (secret: string) => void;
  /** Persist a visual-builder definition via the sidecar (no-op until connected). */
  saveDefinition: (input: {
    name: string;
    manifest: unknown;
    policy?: unknown;
    systemPrompt: string;
    skills?: { path: string; content: string }[];
  }) => void;
  /** The most recent save outcome, once a `definition_saved` frame has arrived. */
  saveResult?: SaveResult;
  /** Request the list of saved definitions (populates `availableDefinitions`). */
  listDefinitions: () => void;
  /** Load a saved definition back into the builder (populates `loadedDefinition`). */
  loadDefinition: (name: string) => void;
  availableDefinitions?: string[];
  loadedDefinition?: LoadedDefinition;
}

/**
 * React binding around `chatReducer`. Opens the loopback WebSocket for the given
 * connection, folds every incoming frame through the pure reducer, and exposes a
 * `send` that both updates local state and forwards the prompt to the sidecar.
 */
export function useChat(connection: Connection | null): UseChat {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  // Track the surfaced ask's id so `answerAsk` (a stable callback) can reject a
  // stale/non-head id without closing over `state`.
  const headAskIdRef = useRef<string | undefined>(undefined);
  const head = state.pendingAsks[0];
  headAskIdRef.current = head?.id;
  // Track the live status so the socket handlers (stable across renders) can tell
  // whether a turn is in-flight when the socket drops, without closing over `state`.
  const statusRef = useRef<ChatStatus>(state.status);
  statusRef.current = state.status;

  useEffect(() => {
    if (!connection) return;
    setConnected(false);
    const url = `ws://127.0.0.1:${connection.port}?token=${encodeURIComponent(connection.token)}`;
    const socket = new WebSocket(url);
    socketRef.current = socket;

    // Distinguish an intentional teardown (unmount / reconnect) from an
    // unexpected drop (sidecar crash / network blip), and fire the drop handler
    // at most once even if onerror and onclose both arrive.
    let closedByCleanup = false;
    let dropped = false;
    const handleDrop = () => {
      setConnected(false);
      if (dropped || closedByCleanup) return;
      dropped = true;
      // If a turn is in-flight when the socket drops, the sidecar can no longer
      // send `done`/`error`, so end the turn ourselves — otherwise it hangs in a
      // streaming state forever. The reducer's `error` handler flips status to
      // idle and clears any pending ask.
      if (statusRef.current === "streaming") {
        dispatch({ type: "server", event: { type: "error", message: "connection to agent lost" } });
      }
    };

    socket.onopen = () => setConnected(true);
    socket.onclose = handleDrop;
    socket.onerror = handleDrop;
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        dispatch({ type: "server", event: frame });
      } catch {
        dispatch({ type: "server", event: { type: "error", message: "malformed message from agent" } });
      }
    };

    return () => {
      closedByCleanup = true;
      socketRef.current = null;
      socket.close();
    };
  }, [connection?.port, connection?.token]);

  const send = useCallback((text: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    dispatch({ type: "send", text });
    socket.send(JSON.stringify({ type: "prompt", text }));
  }, []);

  const submitCredential = useCallback((secret: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // The key travels only over the loopback, token-gated socket to the local
    // sidecar, which writes it to the machine-local encrypted store. Never logged.
    socket.send(JSON.stringify({ type: "set_credential", secret }));
  }, []);

  const saveDefinition = useCallback(
    (input: {
      name: string;
      manifest: unknown;
      policy?: unknown;
      systemPrompt: string;
      skills?: { path: string; content: string }[];
    }) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "save_definition", ...input }));
    },
    [],
  );

  const listDefinitions = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "list_definitions" }));
  }, []);

  const loadDefinition = useCallback((name: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "load_definition", name }));
  }, []);

  const answerAsk = useCallback((id: string, approved: boolean) => {
    // No-op if `id` is not the currently-surfaced ask (stale, already settled,
    // or cancelled by the server): never dequeue or answer the wrong ask.
    if (headAskIdRef.current !== id) return;
    // Advance the queue locally, then forward the answer. If the socket is gone
    // the sidecar has already denied this ask (timeout/disconnect), so no answer
    // needs to fly — fail-closed is preserved either way.
    dispatch({ type: "answer_ask", id });
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ask_response", id, approved }));
    }
  }, []);

  return {
    messages: state.messages,
    status: state.status,
    connected,
    send,
    answerAsk,
    submitCredential,
    saveDefinition,
    listDefinitions,
    loadDefinition,
    ...(state.integrityMessage !== undefined ? { integrityMessage: state.integrityMessage } : {}),
    ...(head !== undefined ? { pendingAsk: head } : {}),
    ...(state.setup !== undefined ? { setup: state.setup } : {}),
    ...(state.saveResult !== undefined ? { saveResult: state.saveResult } : {}),
    ...(state.availableDefinitions !== undefined ? { availableDefinitions: state.availableDefinitions } : {}),
    ...(state.loadedDefinition !== undefined ? { loadedDefinition: state.loadedDefinition } : {}),
  };
}
