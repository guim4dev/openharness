# Walking Skeleton (local-only) — Design

Date: 2026-07-13
Sub-project: 1 of the OpenHarness roadmap (see [`../vision.md`](../vision.md)).
Status: approved in brainstorming; ready for implementation planning.

## Goal

Prove the product's spine end to end, locally, with something usable:

**One `HarnessDefinition` → applied to a forked-Pi core → consumed by two
frontends (TUI + desktop GUI), with a working credential/subscription manager
(multi-account + rotation/failover) supporting OpenCode Go and ChatGPT/Codex from
day one.** No server, no MCP proxy, no policy engine yet.

Success = the same `harnesses/example` definition runs in the branded Pi TUI and
in a minimal Tauri desktop chat, both driving the same core, both rotating across
credential accounts on rate-limit, on macOS/Linux/Windows.

## Non-goals (deferred to later sub-projects)

MCP proxy, central audit, policy-enforcement server, SSO / identity,
approved-build distribution, packaging/signing pipeline, builder UI, cloud
version. Consumer-OAuth ToS resolution beyond the personal-use disclaimer below.

## Phasing (this sub-project splits into 4 implementation plans)

Each phase produces working, testable software on its own:

1. **Phase 1 — Headless core** (`docs/superpowers/plans/2026-07-13-walking-skeleton-phase1-core.md`):
   `definition` + `credentials` (rotation + api-key/OpenCode Go) + `core` (Pi SDK
   wiring + rotation-retry) + `harnesses/example`, driveable via a smoke CLI.
2. **Phase 2 — TUI app** (`apps/tui`): branded entry over Pi's `InteractiveMode`.
3. **Phase 3 — Desktop app** (`apps/desktop`): Tauri + React + Node sidecar (WS).
4. **Phase 4 — `chatgpt-oauth` provider**: Codex subscription via `registerProvider`.

## Architecture

`HarnessDefinition` (a directory) → `definition` parses/validates → `core` loads
it and configures the forked Pi (system prompt, mandatory skills, provider +
credential profile) → two frontends consume the same configured core:

- **TUI**: `core` launches Pi's native TUI, already configured.
- **Desktop**: Pi runs in **JSON-RPC** mode inside a Node **core-sidecar**; the
  Tauri (Rust) shell spawns the sidecar; the web UI (React/Vite) talks to it over
  a **localhost WebSocket**.

```
        HarnessDefinition (harnesses/example)
                     │  definition: parse + validate → typed object
                     ▼
                  core  ── configures ──►  packages/pi (fork)
                 /    \                         │ agent loop, providers, skills
       launchTUI/      \ serve(JSON-RPC)        │
              ▼         ▼                        ▼
         apps/tui   core-sidecar (Node)    credentials (rotation/failover)
        (Pi TUI)      │ WS 127.0.0.1:<port> + ephemeral token
                      ▼
                 apps/desktop (Tauri: Rust shell + React web UI)
```

### Repo layout (pnpm monorepo)

```
openharness/
├─ packages/         # (Pi = npm dependency @earendil-works/pi-coding-agent, not vendored — see D-WS1)
│  ├─ definition/    # HarnessDefinition schema (zod) + loader
│  ├─ credentials/   # accounts, profiles, rotation/failover, AuthProvider registry
│  └─ core/          # loads definition, configures Pi (SDK), exposes session + `serve`
├─ apps/
│  ├─ tui/           # branded entry → core.launchTUI()
│  └─ desktop/       # Tauri (Rust) + React/Vite web UI over JSON-RPC/WS
└─ harnesses/
   └─ example/       # sample HarnessDefinition (the spine's hello-world)
```

### Cross-platform requirements (first-class: Windows, Linux, macOS)

- **Sidecar spawn**: portable Node process spawn (no shell, explicit argv);
  resolve the Node/bin path per-OS.
- **Credential secrets**: OS-native keychain — macOS Keychain, Windows Credential
  Manager (DPAPI), Linux Secret Service — with an encrypted-file fallback where no
  keyring is available (headless Linux). Secrets never in plaintext config.
- **Config/data paths**: `os.homedir()` + XDG (`$XDG_CONFIG_HOME`/`$XDG_DATA_HOME`)
  on Linux, `%APPDATA%` on Windows, `~/Library/Application Support` on macOS. Never
  hardcode `~/.openharness`.
- **Tauri** already targets all three; **CI matrix** builds/tests on all three.

## Components

### Pi (npm dependency — no fork in this slice; see D-WS1)

Pi is `@earendil-works/pi-coding-agent@0.80.6`. Recon (`docs/superpowers/plans/pi-recon.md`)
confirmed the two seams we need are **public APIs**, so no core edit is required:

1. **Credential injection** — `createAgentSession({ authStorage })`; our
   `AuthStorage` (or a swapped `AuthStorageBackend`) resolves the active account's
   credential at call time via `getApiKey()`. Rotation observes streamed errors
   (Pi encodes provider errors into the stream; classify 429/quota/auth via
   `isRetryableAssistantError` + `normalizeProviderError().status`) and re-issues
   with the next healthy account.
2. **Subscription providers** — `pi.registerProvider(name, { baseUrl, oauth: {
   login, refreshToken, getApiKey }, streamSimple })` via an extension; the
   `custom-provider-gitlab-duo` example is the template for an OAuth subscription
   that exchanges a token and delegates to a built-in API impl.

The vendored fork is deferred to when core edits are actually needed (branding
polish, a permission system for non-technical users, distribution) — later phases.

### `packages/definition` — HarnessDefinition

A `HarnessDefinition` is a **directory** with a manifest + assets:

```
harnesses/example/
├─ harness.json
├─ system-prompt.md
├─ skills/triage/SKILL.md
└─ branding/icon.png
```

`harness.json` (v0):

```json
{
  "name": "example",
  "version": "0.1.0",
  "branding": { "displayName": "Acme Assistant", "icon": "branding/icon.png", "accent": "#4F46E5" },
  "systemPrompt": "system-prompt.md",
  "skills": [ { "path": "skills/triage", "mandatory": true } ],
  "providers": {
    "default": { "provider": "anthropic", "model": "claude-sonnet-5", "credentialProfile": "work" }
  }
}
```

The package validates against a **zod** schema, resolves relative paths, and
returns a typed `HarnessDefinition`. **Fail-fast** with a clear message on any
invalid field, missing file, or skill lacking `SKILL.md`. This typed object is the
single contract `core` consumes — TUI and desktop receive exactly the same object.

Decisions: format is **JSON** (`harness.json`) for v0 (aligns with Pi's
`package.json` world, zero parser deps; YAML/TOML can be added later). Skills reuse
**Pi's `SKILL.md` format**, so Pi's skill library is compatible for free.
`credentialProfile` is only a *name* pointing at the credential manager — the
definition never carries a secret.

### `packages/credentials` — auth abstraction + rotation

Mirrors opencode's provider-agnostic auth design (the reference for this space).

**Model:**
- **`StoredCredential`** — `kind: "oauth" | "api_key"`; secret lives in the OS
  keychain (referenced, not embedded); metadata (`expires`, `accountId`,
  `baseURL`, provider info) in config.
- **`Account`** — `{ id, authProviderId, credentialRef, label, health }` where
  `health ∈ { ok, rate_limited_until, exhausted, invalid }`.
- **`Profile`** — a named, **ordered** list of accounts + policy
  (`failover` | `round_robin`). The definition's `credentialProfile` points here.

**`AuthProvider` interface** (pluggable registry — new subscriptions are new
plugins, no core rearchitecture):

```ts
interface AuthProvider {
  id: string;                                   // "api-key" | "chatgpt-oauth" | ...
  authorize(): Promise<{ url?: string; instructions: string; method: "browser" | "device" | "paste" }>;
  callback(input: unknown): Promise<StoredCredential>;   // exchange code→token, or validate key
  refresh?(cred: StoredCredential): Promise<StoredCredential>;
  applyToRequest(cred: StoredCredential, req: ProviderRequest): ProviderRequest; // headers/baseURL/body-transform
}
```

**Rotation/failover (orthogonal to `kind`):** on a model call the manager returns
the profile's active account; on `429`/quota it marks `rate_limited_until`
(honoring `Retry-After`) and rotates to the next healthy account, retrying
transparently; when all are exhausted it surfaces a clear error. OAuth expiry
triggers `refresh()`; refresh failure marks the account `invalid`, rotates, and
surfaces "re-login needed for account X".

**AuthProviders shipped in v0:**
1. **`api-key`** (with custom `baseURL`) — covers **OpenCode Go** for free
   (`baseURL: https://opencode.ai/zen/go/v1`, OpenAI-compatible) plus normal
   Anthropic/OpenAI keys. Login method: `paste`.
2. **`chatgpt-oauth`** — **ChatGPT/Codex subscription**. OAuth PKCE: local
   callback (port 1455-style), client id `app_EMoamEEZ73f0CkXaXp7hrann`,
   `auth.openai.com/oauth/{authorize,token}`, auto-refresh; `applyToRequest`
   targets the ChatGPT backend with the `store: false` transform. Reference
   implementation: the opencode Codex-auth plugin. This is the bulk of the
   credential work in v0.

**ToS decision (D7):** `chatgpt-oauth` ships in v0 **only** as a personal,
bring-your-own-account feature with an explicit in-product disclaimer ("personal
development use only; not for commercial/multi-user use — per OpenAI ToS; use at
your own risk"). For the enterprise/governance positioning, the **recommended**
providers are OpenCode Go, Claude Max, and API keys. This is surfaced, not hidden.

Secrets stored via OS keychain; account metadata in a `0600` config file. No
secret in any committed or synced file.

### `packages/core`

Loads a `HarnessDefinition`, configures the forked Pi (system prompt, mandatory
skills, provider bound to a credential profile via the `CredentialResolver`), and
exposes:
- `launchTUI(harnessPath)` — configure Pi + hand off to its native TUI.
- `serve(harnessPath, { host: "127.0.0.1", port: 0 })` — run Pi in JSON-RPC mode
  behind a localhost WebSocket with an ephemeral token; used by the desktop
  sidecar.

### `apps/tui`

Thin branded entry: `openharness-tui <harness-path>` → `core.launchTUI(...)`.

### `apps/desktop`

Tauri app. The Rust shell spawns the Node core-sidecar (`openharness-core serve`),
receives `{port, token}` on stdout, and passes them to the React/Vite web UI. The
UI opens the WS, authenticates with the token, and renders a chat: user messages
in, streamed assistant tokens + tool-call events out. Non-technical-first UX
(polish via the frontend-design skill in a later pass). Rust supervises the
sidecar (restart-once on crash; "reconnecting" state in the UI).

**Security boundary (explicit):** the core-sidecar binds **loopback only**
(`127.0.0.1`), on a random port, gated by an ephemeral token. No network listener,
no remote auth — this slice is genuinely local-only. Nothing outside the machine
can reach it.

## Data flow

**Desktop:** boot Tauri → spawn sidecar → sidecar binds WS(127.0.0.1:rand)+token,
prints to Rust → UI connects+authenticates → core loads definition, configures Pi,
starts JSON-RPC session → message: UI→WS→core→Pi loop→streamed tokens/tool
events→UI. Model call → credentials active account → `applyToRequest` → Pi calls
provider → `429`/quota → mark+rotate+retry → all exhausted → error event to UI.

**TUI:** `openharness-tui <harness>` → core loads+configures identically → Pi
native TUI. Same credentials + rotation + definition object; only the frontend
differs.

## Error handling

- Invalid definition / missing mandatory skill → fail-fast, clear message
  (non-zero exit in TUI; error screen in desktop).
- No healthy account in profile → clear "add an account / rate-limited until X";
  never crash.
- Provider rate-limit → rotate + retry transparently; structured log of the
  switch; surface only when all exhausted.
- OAuth token expired → auto `refresh()`; on failure mark `invalid`, rotate,
  surface "re-login needed for account X".
- Sidecar crash (desktop) → Rust restarts once, UI shows "reconnecting"; repeated
  failure surfaces an error.
- WS connection without a valid token → refused (loopback-boundary defense).

## Testing (TDD; integration over mocks)

- **`definition`** (unit): valid/invalid fixtures; typed output + fail-fast
  messages.
- **`credentials`** (unit): rotation/failover state machine driven by a fake
  provider emitting `429`/quota/success (+ `Retry-After`); OAuth `refresh()` path
  against a fake token endpoint; all-exhausted behavior.
- **`core`** (integration): load `harnesses/example`, assert Pi is configured with
  the right system prompt + skill + provider (against real Pi objects where
  feasible); use a **stub model provider** so tests need no real keys and burn no
  tokens.
- **E2E smoke**: boot sidecar → open WS → send a message → assert streamed
  response from the stub; simulate a `429` → assert rotation.
- **Desktop smoke**: Rust spawns sidecar; WS handshake + token auth works. Full
  GUI e2e deferred.
- **Cross-platform**: CI matrix (macOS, Linux, Windows) for Node packages + build;
  keychain integration tests may be platform-gated.

## Tech stack

Pi as an npm dependency (`@earendil-works/pi-coding-agent@0.80.6`, Node >=22.19.0);
`definition` / `core` / `credentials` in TypeScript (zod for schemas); TUI in
TypeScript; desktop = Tauri (Rust shell) + React + Vite web UI; **npm workspaces**
(matches Pi's world; the earlier pnpm note is superseded); vitest + Rust tests for
the shell.

## Decisions log (this slice)

| # | Decision | Rationale |
|---|----------|-----------|
| D-WS1 | **REVISED after Pi recon (2026-07-13): Pi consumed as an npm dependency (`@earendil-works/pi-coding-agent@0.80.6`), NOT vendored/forked yet.** | Recon proved every seam we need is a public API — credential injection via `createAgentSession({ authStorage })`, subscription providers via `pi.registerProvider({ oauth, streamSimple })`, prompt/skills/config via flags+env. No core edit required for the skeleton. Upstream auto-closes contributor PRs, so a fork is pure divergence best deferred to when core edits are truly needed (branding polish, permission system, distribution — all deferred non-goals). Reversible anytime. See `docs/superpowers/plans/pi-recon.md`. |
| D-WS2 | Desktop = Tauri (not Electron); web UI React/Vite. | Lighter, smaller signable binary, cross-platform; React polishes later. |
| D-WS3 | Desktop↔core = localhost WebSocket + ephemeral token; Node sidecar spawned by Tauri Rust. | Simple for a web UI to consume; keeps Pi core untouched; loopback-only boundary. |
| D-WS4 | HarnessDefinition = directory + `harness.json` (JSON, zod-validated). | Aligns with Pi's manifest world; zero parser deps; typed single contract. |
| D-WS5 | Auth abstraction = pluggable `AuthProvider` registry (opencode-style two-phase authorize/callback + refresh + applyToRequest). | New subscriptions become plugins; rotation stays orthogonal to credential kind. |
| D-WS6 | v0 ships `api-key` (covers OpenCode Go via baseURL) + `chatgpt-oauth` (Codex). | Satisfies "Codex + OpenCode Go from day one"; OpenCode Go is nearly free, Codex is the bulk. |
| D-WS7 | `chatgpt-oauth` = personal BYO-account only, explicit ToS disclaimer; recommend OpenCode Go / Claude Max / API keys for enterprise. | Honors OpenAI's "personal use only" restriction while still shipping the feature. |

## Open questions for the plan

- Exact shape of Pi's provider/auth internals at the `CredentialResolver` seam —
  confirm against the actual fork before finalizing the interface.
- Whether the desktop sidecar should be a long-lived daemon reused across windows,
  or one-per-window, in v0 (leaning one-per-window for simplicity).
- Keychain library choice per-OS (e.g. `keytar`-style vs Tauri's keyring plugin);
  which owns secret storage — the Node core or the Rust shell.
