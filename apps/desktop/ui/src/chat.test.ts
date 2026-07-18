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

  test("needs_setup moves to the setup state with provider + config path", () => {
    const state = feed(initialChatState, {
      type: "needs_setup",
      provider: "anthropic",
      profile: "work",
      configPath: "/home/u/.config/openharness",
    });
    expect(state.status).toBe("needs_setup");
    expect(state.setup).toEqual({
      provider: "anthropic",
      profile: "work",
      configPath: "/home/u/.config/openharness",
    });
    expect(state.messages).toHaveLength(0);
  });

  test("needs_setup carries a wrong-key error on a retry", () => {
    const state = feed(initialChatState, {
      type: "needs_setup",
      provider: "anthropic",
      profile: "work",
      configPath: "/cfg",
      error: "that key was rejected",
    });
    expect(state.setup?.error).toBe("that key was rejected");
  });

  test("ready clears the setup state and returns to idle", () => {
    let state = feed(initialChatState, {
      type: "needs_setup",
      provider: "anthropic",
      profile: "work",
      configPath: "/cfg",
    });
    expect(state.status).toBe("needs_setup");
    state = feed(state, { type: "ready" });
    expect(state.status).toBe("idle");
    expect(state.setup).toBeUndefined();
  });

  test("an ask event records the pending approval", () => {
    const state = feed(initialChatState, {
      type: "ask",
      id: "ask-1",
      toolName: "danger_tool",
      reason: "danger_tool needs approval",
    });
    expect(state.pendingAsks[0]).toEqual({
      id: "ask-1",
      toolName: "danger_tool",
      reason: "danger_tool needs approval",
    });
  });

  test("an ask mid-stream leaves the stream intact", () => {
    let state = feed(initialChatState, { type: "token", text: "thinking" });
    state = feed(state, { type: "ask", id: "ask-2", toolName: "shell" });
    // The streaming assistant bubble is untouched; only the queue head is added.
    expect(state.status).toBe("streaming");
    expect(state.messages.at(-1)?.text).toBe("thinking");
    expect(state.pendingAsks[0]?.id).toBe("ask-2");
  });

  test("answer_ask clears the head of the pending queue", () => {
    const asked = feed(initialChatState, { type: "ask", id: "ask-3", toolName: "shell" });
    expect(asked.pendingAsks[0]).toBeDefined();

    const answered = chatReducer(asked, { type: "answer_ask", id: "ask-3" });
    expect(answered.pendingAsks).toHaveLength(0);
  });

  test("answer_ask for a non-head id is a no-op", () => {
    const asked = feed(initialChatState, { type: "ask", id: "ask-4", toolName: "shell" });
    const answered = chatReducer(asked, { type: "answer_ask", id: "not-ask-4" });
    expect(answered.pendingAsks[0]?.id).toBe("ask-4"); // untouched
  });

  test("ask_cancelled clears the matching pending ask (server denied it out-of-band)", () => {
    const asked = feed(initialChatState, { type: "ask", id: "ask-5", toolName: "shell" });
    expect(asked.pendingAsks[0]?.id).toBe("ask-5");

    const cancelled = feed(asked, { type: "ask_cancelled", id: "ask-5", reason: "timeout" });
    expect(cancelled.pendingAsks).toHaveLength(0);
  });

  test("done defensively clears any still-pending ask", () => {
    let state = feed(initialChatState, { type: "token", text: "partial" });
    state = feed(state, { type: "ask", id: "ask-6", toolName: "shell" });
    expect(state.pendingAsks).toHaveLength(1);

    state = feed(state, { type: "done" });
    expect(state.pendingAsks).toHaveLength(0);
  });

  test("error defensively clears a still-pending ask mid-stream (Finding 1)", () => {
    let state = feed(initialChatState, { type: "token", text: "partial" });
    state = feed(state, { type: "ask", id: "ask-err", toolName: "shell" });
    expect(state.pendingAsks).toHaveLength(1);

    // An error ends the turn; a pending approval must not survive into the next
    // turn as a stale ask (mirror the `done` handler).
    state = feed(state, { type: "error", message: "model unavailable" });
    expect(state.pendingAsks).toHaveLength(0);
    expect(state.status).toBe("idle");
  });

  test("error with no open stream still clears a pending ask (Finding 1)", () => {
    let state = feed(initialChatState, { type: "ask", id: "ask-err2", toolName: "shell" });
    expect(state.pendingAsks).toHaveLength(1);

    state = feed(state, { type: "error", message: "could not connect" });
    expect(state.pendingAsks).toHaveLength(0);
    expect(state.status).toBe("idle");
  });

  test("concurrent asks queue and surface one at a time (Finding 5)", () => {
    let state = feed(
      initialChatState,
      { type: "ask", id: "ask-a", toolName: "tool_a" },
      { type: "ask", id: "ask-b", toolName: "tool_b" },
    );
    // Both are queued; the first is surfaced (head), the second waits.
    expect(state.pendingAsks.map((a) => a.id)).toEqual(["ask-a", "ask-b"]);
    expect(state.pendingAsks[0]?.id).toBe("ask-a");

    // Answering the head surfaces the next one.
    state = chatReducer(state, { type: "answer_ask", id: "ask-a" });
    expect(state.pendingAsks.map((a) => a.id)).toEqual(["ask-b"]);
    expect(state.pendingAsks[0]?.id).toBe("ask-b");

    // Answering the (now head) second clears the queue.
    state = chatReducer(state, { type: "answer_ask", id: "ask-b" });
    expect(state.pendingAsks).toHaveLength(0);
  });

  test("a duplicate ask id does not double-queue", () => {
    const state = feed(
      initialChatState,
      { type: "ask", id: "dup", toolName: "shell" },
      { type: "ask", id: "dup", toolName: "shell" },
    );
    expect(state.pendingAsks).toHaveLength(1);
  });

  test("definition_saved records the save outcome without touching chat status", () => {
    const state = feed(initialChatState, {
      type: "definition_saved",
      ok: true,
      dir: "/cfg/definitions/acme",
      problems: [{ level: "warn", code: "mcp-server-unpinned", message: "pin it" }],
    });
    expect(state.status).toBe("idle"); // authoring is orthogonal to the conversation
    expect(state.saveResult).toEqual({
      ok: true,
      dir: "/cfg/definitions/acme",
      problems: [{ level: "warn", code: "mcp-server-unpinned", message: "pin it" }],
    });
  });

  test("definitions_listed populates the available list", () => {
    const state = feed(initialChatState, { type: "definitions_listed", names: ["acme", "meridian"] });
    expect(state.availableDefinitions).toEqual(["acme", "meridian"]);
  });

  test("definition_loaded stashes the raw files; an error payload is ignored", () => {
    const ok = feed(initialChatState, {
      type: "definition_loaded",
      name: "acme",
      manifest: { name: "acme" },
      policy: { default: "deny", rules: [] },
      systemPrompt: "hi",
    });
    expect(ok.loadedDefinition).toEqual({
      name: "acme",
      manifest: { name: "acme" },
      policy: { default: "deny", rules: [] },
      systemPrompt: "hi",
    });
    // An error load leaves the current draft alone (no loadedDefinition set).
    const err = feed(initialChatState, { type: "definition_loaded", name: "gone", error: "not found" });
    expect(err.loadedDefinition).toBeUndefined();
  });
});

/** Minimal synchronous WebSocket stand-in the hook drives during the test. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
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
  // Simulate an abnormal socket error (sidecar crash / network blip).
  error() {
    this.onerror?.();
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

  test("raises a pending ask, and answering it sends ask_response and clears the modal", () => {
    const { result } = renderHook(() => useChat({ port: 4321, token: "secret" }));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());

    act(() =>
      socket.emit({ type: "ask", id: "ask-9", toolName: "danger_tool", reason: "needs OK" }),
    );
    expect(result.current.pendingAsk).toEqual({
      id: "ask-9",
      toolName: "danger_tool",
      reason: "needs OK",
    });

    act(() => result.current.answerAsk("ask-9", true));
    expect(socket.sent).toContain(
      JSON.stringify({ type: "ask_response", id: "ask-9", approved: true }),
    );
    expect(result.current.pendingAsk).toBeUndefined();
  });

  test("surfaces two concurrent asks one at a time; each is answerable in turn", () => {
    const { result } = renderHook(() => useChat({ port: 4321, token: "secret" }));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());

    act(() => {
      socket.emit({ type: "ask", id: "q1", toolName: "tool_a" });
      socket.emit({ type: "ask", id: "q2", toolName: "tool_b" });
    });
    // Only the first is surfaced.
    expect(result.current.pendingAsk?.id).toBe("q1");

    act(() => result.current.answerAsk("q1", true));
    expect(socket.sent).toContain(JSON.stringify({ type: "ask_response", id: "q1", approved: true }));
    // The second now surfaces and is answerable.
    expect(result.current.pendingAsk?.id).toBe("q2");

    act(() => result.current.answerAsk("q2", false));
    expect(socket.sent).toContain(JSON.stringify({ type: "ask_response", id: "q2", approved: false }));
    expect(result.current.pendingAsk).toBeUndefined();
  });

  test("answerAsk for a non-head id is a no-op (no ask_response sent)", () => {
    const { result } = renderHook(() => useChat({ port: 4321, token: "secret" }));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());

    act(() => socket.emit({ type: "ask", id: "head", toolName: "tool_a" }));
    // A stale/settled id must not fire a WS answer.
    act(() => result.current.answerAsk("stale-id", true));
    expect(socket.sent).not.toContain(
      JSON.stringify({ type: "ask_response", id: "stale-id", approved: true }),
    );
    // The real pending ask is untouched.
    expect(result.current.pendingAsk?.id).toBe("head");
  });

  test("ask_cancelled from the server clears the modal without an answer", () => {
    const { result } = renderHook(() => useChat({ port: 4321, token: "secret" }));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());

    act(() => socket.emit({ type: "ask", id: "c1", toolName: "tool_a", reason: "needs OK" }));
    expect(result.current.pendingAsk?.id).toBe("c1");

    act(() => socket.emit({ type: "ask_cancelled", id: "c1", reason: "timeout" }));
    expect(result.current.pendingAsk).toBeUndefined();
    // No stale answer was sent for the cancelled ask.
    expect(socket.sent.some((s) => s.includes("ask_response"))).toBe(false);
  });

  test("an onclose mid-stream ends the turn with a connection-lost error (Finding 2)", () => {
    const { result } = renderHook(() => useChat({ port: 4321, token: "secret" }));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());

    act(() => result.current.send("hello"));
    act(() => socket.emit({ type: "token", text: "partial" }));
    // A live turn: streaming, with a dangling approval.
    act(() => socket.emit({ type: "ask", id: "drop-ask", toolName: "shell" }));
    expect(result.current.status).toBe("streaming");
    expect(result.current.pendingAsk?.id).toBe("drop-ask");

    // The loopback socket drops mid-stream (sidecar crash / blip).
    act(() => socket.close());

    // The turn must not hang: it terminates to idle, the ask is cleared, and a
    // connection-lost error is surfaced.
    expect(result.current.status).toBe("idle");
    expect(result.current.connected).toBe(false);
    expect(result.current.pendingAsk).toBeUndefined();
    expect(result.current.messages.filter((m) => m.error)).toHaveLength(1);
  });

  test("an onerror mid-stream also ends the turn (Finding 2)", () => {
    const { result } = renderHook(() => useChat({ port: 4321, token: "secret" }));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());

    act(() => result.current.send("hi"));
    act(() => socket.emit({ type: "token", text: "partial" }));
    expect(result.current.status).toBe("streaming");

    act(() => socket.error());

    expect(result.current.status).toBe("idle");
    expect(result.current.messages.filter((m) => m.error)).toHaveLength(1);
  });

  test("a normal close with no in-flight turn surfaces no error (Finding 2)", () => {
    const { result } = renderHook(() => useChat({ port: 4321, token: "secret" }));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());

    // Idle: no streaming turn. A close must not fabricate an error bubble.
    act(() => socket.close());

    expect(result.current.connected).toBe(false);
    expect(result.current.messages.filter((m) => m.error)).toHaveLength(0);
  });
});
