# Governance Data Plane — Design (Fable-advised)

Date: 2026-07-13
Sub-project: 2 of the OpenHarness roadmap (the "don't lose control" half).
Status: designed (advisor: Fable), ready to implement phase by phase.
Supersedes: the earlier "control plane = server + MCP proxy, built first" framing.

## Core correction (why this shape)

Enforcement must be **in-process, in the harness** — local-first requires offline
enforcement, and Pi's `tool_call` hook is the only seam that sees *every* tool call
with full context and can't be routed around by the model. The **server is
initially dumb**: a signed-bundle host + an audit sink. Building a server first
would govern a data plane that doesn't exist yet (Pi has no MCP → no external calls
to proxy). So: **build the data plane first; the server is small and last.**

## Phases (each independently testable; own branch → workflow → verify → merge)

### DP1 — `@openharness/mcp`: MCP client + Pi tool bridge
Bring MCP to the harness (Pi has none), already the enforcement seam.
- MCP clients: **stdio** and **streamable-HTTP** (official `@modelcontextprotocol/sdk`).
- Each MCP tool → a Pi tool via `pi.registerTool`/`defineTool`, namespaced
  `mcp__<server>__<tool>`.
- `harness.json` gains an `mcp` section: `{ servers: { <name>: { transport, command|url,
  args?, env?, mandatory?: bool, tools?: allowlist } } }`. Mandatory servers must
  connect or the harness fails fast.
- Every external tool call now flows through code we own.

### DP2 — `@openharness/policy`: policy engine, enforced via Pi hooks
- `policy.json` in the definition dir (zod-typed; ships with the harness, signed in DP4).
- **Claude Code-style permission rules**, first-match, **deny-by-default** posture:
  ```
  rules: [ { match: "mcp__linear__delete_*", action: "deny", reason: "..." },
           { match: "bash(git *)",           action: "allow" },
           { match: "mcp__*__*",              action: "ask" } ]
  models: { allow: ["anthropic/claude-*"] }
  redact: [ { pattern: "AKIA[0-9A-Z]{16}", replace: "[aws-key]" } ]
  ```
- Enforcement seams (verified present in Pi): `tool_call` → allow/deny/ask + in-place
  `event.input` mutation for arg redaction; `tool_result` → response-side redaction
  (secrets flowing *back into context* is the forgotten leak); `before_provider_request`
  → model/provider allowlist.
- No OPA/Cedar. Deterministic, boring, auditable.

### DP3 — Audit log (local-first)
- Append-only **JSONL**, versioned event schema, emitted from the **same code path**
  as enforcement (audit and policy can never diverge).
- Logs: tool name, server, decision + rule id, args hash (raw args only behind an org
  flag), model requests + token counts, definition version, which pooled account served.
- **External calls only. No prompts/conversation by default** (privacy + works-council
  defense); prompt capture is an explicit org opt-in.
- **Hash-chained** entries → cheap local self-consistency: `verifyAuditLog` catches
  accidental corruption and naive in-place edits. It is **not** forgery-proof on its own
  (keyless chain, public genesis — a writer can recompute the chain). Real tamper-evidence
  is **server-side**: `POST /audit` retains a per-source HEAD and rejects any submission
  that does not continue it (re-chain from genesis, fork, or seq gap). The server's
  retained copy is the anchor of trust.

### DP4 — Signed definition bundles (the real "distribution/identity" MVP)
- `openharness bundle` → tar of definition + policy + version manifest, **ed25519-signed**.
- Org pubkey baked into the branded build; client **refuses unsigned/stale** bundles and
  re-fetches from an HTTPS URL on startup (a GitHub release is a valid v0 host). TUF-lite.
- Delivers "only approved config runs" + central update/rollback of *behavior* without
  auth infra.

### DP5 — Thin server (only if the night is long)
- Two endpoints: `GET /bundle` (signed bundle + version), `POST /audit` (batched NDJSON,
  buffer locally when offline). No dashboard, no SSO, no org model.

## After the data plane — the moat (separate epics, not tonight unless time)
1. **Definition→artifact pipeline** (`openharness build`): a definition dir → a branded,
   signed, auto-updating TUI + desktop installer with policy + pubkey baked in.
   Category-of-one. **Highest-leverage moat.**
2. **Governed credential pooling → remote MCP gateway**: org keys live server-side,
   employees auth with identity not keys, every call attributed to person + account.
   Pooling and the gateway are the same feature from two sides, and the enforcement backstop.

## Decisions (added to vision.md)
- **D10** — Governance data plane first; enforcement in-process via Pi hooks; server dumb + last.
- **D11** — **NEVER pool consumer OAuth subscriptions (Claude/ChatGPT) across users** — ToS
  violation, gets the customer banned. Pooling/rotation is for **org API keys / enterprise
  seats only**. A consumer subscription = a single personal user.
- **D12** — v1 targets **technical employees** (Pi is a coding agent — bash/repo model).
  Non-technical desktop UX (support/ops, no-terminal ask-flow) is a later epic; but design
  `policy.json`'s `ask` semantics now so the GUI ask-dialog is a renderer, not a redesign.

## Non-goals (tonight)
SSO, remote MCP gateway, audit dashboard, curated prompt library, signed *builds* (vs signed
*definitions*), non-technical desktop UX. All real, all later.

## Honest limits (Fable's blind spots, kept visible)
- Local-first enforcement is bypassable by a determined employee with a debugger. Honest
  layered answer: signed builds + hash-chained logs make tampering *evident*; the remote
  gateway (later) makes it *pointless* (no gateway token → no access; the credential never
  touched the laptop).
- Pi API churn: pin the version, wrap every Pi type behind our own interfaces in `core`,
  keep live-session integration tests as the canary.
- MCP remote auth (OAuth 2.1 + dynamic client registration) is a multi-day swamp — the
  pluggable AuthProvider registry is the right shape; budget for it, don't discover it mid-gateway.
