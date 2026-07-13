import { useEffect, useMemo, useRef, useState } from "react";
import { useChat, type ChatMessage, type Connection } from "./chat.ts";

declare global {
  interface Window {
    /** Injected by the Tauri shell: the loopback sidecar coordinates. */
    __OPENHARNESS__?: { port: number; token: string };
  }
}

/** Prefer the Tauri-injected globals; fall back to ?port=&token= for browser dev. */
function readConnection(): Connection | null {
  const injected = window.__OPENHARNESS__;
  if (injected && typeof injected.port === "number" && typeof injected.token === "string") {
    return { port: injected.port, token: injected.token };
  }
  const params = new URLSearchParams(window.location.search);
  const port = Number(params.get("port"));
  const token = params.get("token");
  if (Number.isFinite(port) && port > 0 && token) return { port, token };
  return null;
}

function TypingDots() {
  return (
    <span className="typing" aria-label="The assistant is typing">
      <span />
      <span />
      <span />
    </span>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const tone = message.error ? "error" : message.role;
  const waiting = message.role === "assistant" && message.streaming && message.text.length === 0;
  return (
    <div className={`row row-${message.role}`}>
      <div className={`bubble bubble-${tone}`}>
        {waiting ? <TypingDots /> : message.text}
      </div>
    </div>
  );
}

function statusLabel(connection: Connection | null, connected: boolean, streaming: boolean): string {
  if (!connection) return "Not connected";
  if (!connected) return "Connecting…";
  return streaming ? "Thinking…" : "Ready";
}

export function App() {
  const connection = useMemo(readConnection, []);
  const { messages, status, connected, send } = useChat(connection);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const streaming = status === "streaming";
  const canSend = connected && !streaming && draft.trim().length > 0;

  function submit() {
    if (!canSend) return;
    send(draft.trim());
    setDraft("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">OpenHarness</div>
        <div className={`status status-${connected ? "on" : "off"}`}>
          <span className="dot" />
          {statusLabel(connection, connected, streaming)}
        </div>
      </header>

      <main className="messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="welcome">
            <h1>How can I help?</h1>
            <p>Type a message below to start the conversation.</p>
          </div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </main>

      <footer className="composer">
        <div className="composer-inner">
          <textarea
            className="input"
            aria-label="Message the assistant"
            placeholder={connection ? "Message the assistant…" : "Waiting for the agent to connect…"}
            rows={1}
            value={draft}
            disabled={!connection}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="send" type="button" onClick={submit} disabled={!canSend}>
            Send
          </button>
        </div>
        <p className="hint">Press Enter to send · Shift + Enter for a new line</p>
      </footer>
    </div>
  );
}
