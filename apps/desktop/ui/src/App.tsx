import { useEffect, useMemo, useRef, useState } from "react";
import { useChat, type ChatMessage, type Connection, type PendingAsk } from "./chat.ts";

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

/**
 * Policy approval modal. Shown when a tool call is gated behind a policy `ask`.
 * Calm and obvious on purpose: one clear question, the policy's reason, and two
 * unambiguous choices. Any dismissal (Deny, Escape, backdrop) denies the tool —
 * fail-closed carried all the way to the UI. Approve is the deliberate action.
 */
function AskModal({
  ask,
  onDecide,
}: {
  ask: PendingAsk;
  onDecide: (id: string, approved: boolean) => void;
}) {
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the safe default (Deny) and let Escape stand in for it.
    denyRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onDecide(ask.id, false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask.id, onDecide]);

  return (
    <div
      className="ask-backdrop"
      role="presentation"
      onClick={() => onDecide(ask.id, false)}
    >
      <div
        className="ask-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ask-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l8.5 4.8v6.9c0 3.9-3.4 6.8-8.5 8-5.1-1.2-8.5-4.1-8.5-8V7.8L12 3z" />
            <path d="M12 9.2v3.6" />
            <path d="M12 15.6h.01" />
          </svg>
        </div>
        <h2 id="ask-title" className="ask-title">
          Allow <span className="ask-tool">{ask.toolName}</span> to run?
        </h2>
        <p className="ask-reason">
          {ask.reason ?? "This action requires your approval before it can run."}
        </p>
        <div className="ask-actions">
          <button
            ref={denyRef}
            className="ask-btn ask-deny"
            type="button"
            onClick={() => onDecide(ask.id, false)}
          >
            Deny
          </button>
          <button
            className="ask-btn ask-approve"
            type="button"
            onClick={() => onDecide(ask.id, true)}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const connection = useMemo(readConnection, []);
  const { messages, status, connected, send, integrityMessage, pendingAsk, answerAsk } =
    useChat(connection);
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

      {pendingAsk ? <AskModal ask={pendingAsk} onDecide={answerAsk} /> : null}
    </div>
  );
}
