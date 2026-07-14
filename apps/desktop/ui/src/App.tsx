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

/**
 * Verify-on-boot refusal screen. Shown when the sidecar reports that the
 * configuration could not be cryptographically verified. Calm and legible on
 * purpose — a locked door, not a stack trace. The technical detail is offered
 * quietly for whoever needs it, but the headline stays human.
 */
function IntegrityLock({ detail }: { detail?: string }) {
  return (
    <div className="lock" role="alert" aria-live="assertive">
      <div className="lock-card">
        <div className="lock-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
            <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
        <h1>Configuration could not be verified</h1>
        <p className="lock-lead">
          This app only runs a configuration signed by your organization. The
          configuration it was given did not pass that check, so it has been
          locked to keep you safe.
        </p>
        <p className="lock-sub">
          The app stays locked until a valid, signed configuration is provided.
          Please contact whoever set this up.
        </p>
        {detail ? <p className="lock-detail">Details: {detail}</p> : null}
      </div>
    </div>
  );
}

export function App() {
  const connection = useMemo(readConnection, []);
  const { messages, status, connected, send, integrityMessage } = useChat(connection);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Verify-on-boot refusal takes over the whole window: no chat surface at all.
  if (status === "integrity_error") {
    return <IntegrityLock {...(integrityMessage !== undefined ? { detail: integrityMessage } : {})} />;
  }

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
