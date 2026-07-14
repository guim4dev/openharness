// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  chatReducer,
  initialChatState,
  useChat,
  type ChatState,
  type ServerMessage,
} from "./chat.ts";

/** Fold a sequence of server frames through the pure reducer. */
function feed(state: ChatState, ...events: ServerMessage[]): ChatState {
  return events.reduce((s, event) => chatReducer(s, { type: "server", event }), state);
}

describe("chatReducer", () => {
  test("accumulates token deltas into a single assistant message", () => {
    const state = feed(
      initialChatState,
      { type: "token", text: "Hel" },
      { type: "token", text: "lo, " },
      { type: "token", text: "there" },
    );

    const assistants = state.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe("Hello, there");
    expect(assistants[0].streaming).toBe(true);
    expect(state.status).toBe("streaming");
  });

  test("streams into the placeholder created by a local send", () => {
    let state = chatReducer(initialChatState, { type: "send", text: "hi agent" });
    state = feed(state, { type: "token", text: "one " }, { type: "token", text: "two" });

    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.messages[0].text).toBe("hi agent");
    expect(state.messages[1].text).toBe("one two");
    // Still a single assistant bubble, not one per delta.
    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  test("finalizes the streaming message on done", () => {
    let state = feed(initialChatState, { type: "token", text: "answer" });
    expect(state.status).toBe("streaming");

    state = feed(state, { type: "done" });
    const assistant = state.messages.at(-1);
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.text).toBe("answer");
    expect(state.status).toBe("idle");
  });

  test("surfaces an error event", () => {
    let state = feed(initialChatState, { type: "token", text: "partial" });
    state = feed(state, { type: "error", message: "model unavailable" });

    const errored = state.messages.filter((m) => m.error);
    expect(errored).toHaveLength(1);
    expect(errored[0].text).toBe("model unavailable");
    expect(errored[0].streaming).toBe(false);
    expect(state.status).toBe("idle");
  });

  test("surfaces an error with no open stream as a standalone bubble", () => {
    const state = feed(initialChatState, { type: "error", message: "could not connect" });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].error).toBe(true);
    expect(state.messages[0].text).toBe("could not connect");
    expect(state.status).toBe("idle");
  });

  test("an integrity_error moves state to the terminal refusal state", () => {
    const state = feed(initialChatState, {
      type: "integrity_error",
      message: "signature verification failed",
    });
    expect(state.status).toBe("integrity_error");
    expect(state.integrityMessage).toBe("signature verification failed");
    // No chat bubbles: the refusal replaces the conversation entirely.
    expect(state.messages).toHaveLength(0);
  });

  test("integrity_error overrides an in-flight stream", () => {
    let state = feed(initialChatState, { type: "token", text: "partial answer" });
    expect(state.status).toBe("streaming");

    state = feed(state, { type: "integrity_error", message: "bundle tampered" });
    expect(state.status).toBe("integrity_error");
    expect(state.integrityMessage).toBe("bundle tampered");
  });
});

/** Minimal synchronous WebSocket stand-in the hook drives during the test. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // Test-only drivers:
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emit(frame: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("useChat", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("forwards prompts and folds streamed frames into state", () => {
    const { result } = renderHook(() => useChat({ port: 4321, token: "secret" }));

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain("ws://127.0.0.1:4321");
    expect(socket.url).toContain("token=secret");

    act(() => socket.open());
    expect(result.current.connected).toBe(true);

    act(() => result.current.send("hello"));
    expect(socket.sent).toEqual([JSON.stringify({ type: "prompt", text: "hello" })]);

    act(() => {
      socket.emit({ type: "token", text: "Hi " });
      socket.emit({ type: "token", text: "there" });
    });
    act(() => socket.emit({ type: "done" }));

    const assistants = result.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe("Hi there");
    expect(assistants[0].streaming).toBe(false);
    expect(result.current.status).toBe("idle");
  });

  test("does not send before the socket is open", () => {
    const { result } = renderHook(() => useChat({ port: 4321, token: "secret" }));
    const socket = FakeWebSocket.instances[0];

    act(() => result.current.send("too early"));
    expect(socket.sent).toEqual([]);
    expect(result.current.messages).toHaveLength(0);
  });
});
