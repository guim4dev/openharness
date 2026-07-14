# OpenHarness — Architecture

How the pieces fit. For the *why*, see [`vision.md`](vision.md); to author a
harness, see [`AUTHORING.md`](AUTHORING.md).

## The one-liner, structurally

One **HarnessDefinition** → configured onto a Pi agent core → consumed by **two
frontends** (TUI + desktop), with **governance enforced in-process** and
**distribution via signed bundles**.

```
                    HarnessDefinition (a directory)
                    harness.json · system prompt · policy.json
                    · mcp servers · skills · branding · provider
                                   │
                    @openharness/definition  (parse + validate → typed object)
                                   │
         ┌─────────────────────────┴──────────────────────────┐
         │                  @openharness/core                  │
         │  createLiveSession: builds a real in-process Pi      │
         │  AgentSession (Pi is an npm dependency) and wires:   │
         │   • credentials  → provider-scoped AuthStorage       │
         │   • MCP tools     (@openharness/mcp)                 │
         │   • policy+audit  in-process extension (Pi hooks)    │
         └───────┬───────────────────────────────────┬─────────┘
                 │                                     │
          apps/tui (InteractiveMode)        apps/desktop (Tauri shell +
          — technical users                  React UI + Node WS sidecar)
                                             — everyone else
```

Pi is consumed as an npm dependency (`@earendil-works/pi-coding-agent`); every
seam we need is a public API (see "Pi seams" below), so there is no fork.

## Packages

| Package | Responsibility |
|---|---|
| `@openharness/definition` | `HarnessDefinition` schema (zod) + loader; resolves prompts (incl. `lib:` refs), skills, mcp, branding. |
| `@openharness/credentials` | Encrypted secret store; **provider-scoped** multi-account rotation/failover; pluggable `AuthProvider` registry; api-key provider (covers OpenCode Go). |
| `@openharness/mcp` | MCP client (stdio + streamable-HTTP) → bridges each MCP tool to a Pi tool `mcp__<server>__<tool>`; mandatory servers fail fast; server secrets by reference. |
| `@openharness/policy` | Deny-by-default first-match rules + secret redaction + model allow/deny + argument-matching. Pure engine. |
| `@openharness/audit` | Hash-chained JSONL, external calls only; `verifyAuditLog`. |
| `@openharness/bundle` | ed25519-signed `.ohbundle` definition bundles; `verifyBundle`/`loadVerifiedDefinition` (fail-closed, traversal-safe, anti-rollback). |
| `@openharness/server` | Thin `GET /bundle` + `POST /audit` (per-source chain-verified), bearer-gated, loopback. |
| `@openharness/build` | `openharness build` — a definition → a branded, signed, ready-to-package Tauri project. |
| `@openharness/prompts` | Curated prompt library (`loadPromptLibrary`/`resolvePrompt`). |
| `@openharness/core` | Ties Pi to everything above: `createLiveSession`, `loadAccounts`, the policy/audit extension, the `openharness` CLI. |
| `apps/tui`, `apps/desktop` | The two frontends. |

Dependency direction flows toward `core`; `core` depends on Pi. Every Pi type we
touch is wrapped behind our own interfaces (Pi API churn is contained there).

## Governance is a data plane, enforced in-process

Enforcement lives **inside the harness process**, at Pi's extension hooks — the
only seam that sees every tool call with full context and can't be routed around
by the model. The server is a dumb signed-bundle host + audit sink.

**A tool call:**
```
model emits a tool call
  → Pi `tool_call` hook (our policy extension):
       decideTool(policy, name, args)
         deny  → block (model sees the reason as an error result)
         ask   → askUser() (TUI dialog / desktop modal; fail-closed if none)
         allow → redact args in place (secrets never reach the tool)
       audit.record(decision, redacted argsHash)   [wrapped fail-closed]
  → tool executes
  → Pi `tool_result` hook: redact the result (secrets never re-enter context),
       audit.record(resultHash)                    [wrapped fail-closed]
```
**A model call:** `before_provider_request` gates the model against the policy's
allow/deny. Credentials are resolved **per target provider** — a harness for
provider X is only ever handed provider X's key.

## Distribution & trust

```
openharness keygen         → org ed25519 keypair (private key stays with the org)
openharness build acme/    → signs the definition into acme.ohbundle,
                             bakes {bundle, org.pub, min-version, sidecar} as
                             sealed Tauri resources, templates a branded app
app launch (release)       → sidecar loadVerifiedDefinition(bundle, org.pub):
                             bad signature / tampered file / older-than-floor
                             → integrity-refusal screen (never runs)
openharness serve          → GET /bundle (central update) · POST /audit
                             (authoritative, chain-verified retention)
```
Per-app **identifier** isolation keeps two branded apps' credentials/audit/state
apart. Three independent trust artifacts: our definition signature (v1 core), the
Tauri updater signature (later), OS code-signing (later).

## Pi seams (for contributors)

- **Session**: `createAgentSessionServices(...)` → `createAgentSessionFromServices({..., customTools})` (what `createLiveSession` uses); tokens stream via `session.subscribe` `message_update.assistantMessageEvent` deltas.
- **Credentials**: an injected `AuthStorage` whose runtime override we drive per provider.
- **Governance hooks**: registered in-process via `resourceLoaderOptions.extensionFactories` (an `InlineExtension`) — no `-e` file. Hooks: `tool_call` (`{block,reason}` + mutate `event.input`), `tool_result`, `before_provider_request`.
- **Desktop resources**: `main.rs` resolves baked resources via `resource_dir()` in release, `cfg(debug_assertions)` for dev.

## Honest boundary

Local-first enforcement is bypassable by a determined employee with a debugger.
Signed builds + hash-chained audit make tampering **evident**; the (roadmap)
remote MCP gateway — org secrets server-side — makes it **pointless**. See
[`SECURITY.md`](../SECURITY.md).
