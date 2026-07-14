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
   * Verify-on-boot refusal from the sidecar: the configuration could not be
   * cryptographically verified. Locks the UI — no chat is possible this session.
   */
  | { type: "integrity_error"; message: string };

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

export type ChatStatus = "idle" | "streaming" | "integrity_error";

/** An outstanding policy approval the user must answer before the tool runs. */
export interface PendingAsk {
  id: string;
  toolName: string;
  reason?: string;
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
   * Set while a policy `ask` awaits the user's decision. Drives the approval
   * modal; cleared by an `answer_ask` action once the user approves or denies.
   */
  pendingAsk?: PendingAsk;
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
      if (last && last.role === "assistant" && last.streaming) {
        return {
          ...state,
          status: "idle",
          messages: replaceLast(state.messages, { ...last, streaming: false }),
        };
      }
      return { ...state, status: "idle" };
    }

    case "error": {
      // Turn the open assistant bubble (if any) into the error, otherwise add a
      // standalone error bubble. Either way the failure is surfaced to the user.
      if (last && last.role === "assistant" && last.streaming) {
        return {
          ...state,
          status: "idle",
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
      // A tool call is suspended pending the user's approval. Record it so the
      // UI can raise the modal; the turn's status stays as-is (still streaming).
      return {
        ...state,
        pendingAsk: {
          id: event.id,
          toolName: event.toolName,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      };
    }

    case "integrity_error": {
      // Terminal: the definition failed verification on boot. Lock the whole UI
      // into a dedicated refusal state — this overrides any in-flight stream and
      // no further chat is possible for this session.
      return { ...state, status: "integrity_error", integrityMessage: event.message };
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
      // Clear the modal once the user has answered THIS ask (ignore stale ids).
      if (!state.pendingAsk || state.pendingAsk.id !== action.id) return state;
      const { pendingAsk: _answered, ...rest } = state;
      return rest;
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
  /** Set while a policy `ask` awaits the user's decision. Drives the approval modal. */
  pendingAsk?: PendingAsk;
  /** Answer the pending ask: forwards `ask_response` to the sidecar and clears the modal. */
  answerAsk: (id: string, approved: boolean) => void;
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

  useEffect(() => {
    if (!connection) return;
    setConnected(false);
    const url = `ws://127.0.0.1:${connection.port}?token=${encodeURIComponent(connection.token)}`;
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        dispatch({ type: "server", event: frame });
      } catch {
        dispatch({ type: "server", event: { type: "error", message: "malformed message from agent" } });
      }
    };

    return () => {
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

  const answerAsk = useCallback((id: string, approved: boolean) => {
    // Always clear the modal locally. If the socket is gone the sidecar has
    // already denied this ask (timeout/disconnect), so no answer needs to fly —
    // fail-closed is preserved either way.
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
    ...(state.integrityMessage !== undefined ? { integrityMessage: state.integrityMessage } : {}),
    ...(state.pendingAsk !== undefined ? { pendingAsk: state.pendingAsk } : {}),
  };
}
