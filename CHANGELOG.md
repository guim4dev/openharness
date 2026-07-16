# Changelog

All notable changes to OpenHarness. This project adheres to
[Semantic Versioning](https://semver.org) and
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased] — 2026-07-14 (initial build)

The first end-to-end build: a company can define its own harness and ship it,
governed and signed, to a TUI and a desktop app. 420 tests, MIT, built on
[Pi](https://pi.dev).

### Added

- **Harness core** — `@openharness/definition` (a `HarnessDefinition` = `harness.json`
  + optional `policy.json` + `mcp` section, zod-validated), `@openharness/core`
  (`createLiveSession` drives a real in-process Pi session and streams tokens;
  cross-platform per-identifier paths; `loadAccounts` BYO-key; the
  `openharness chat / init / doctor / keygen / bundle / build / serve` CLI, with
  a top-level `--help` listing every subcommand).
- **Two frontends from one definition** — `apps/tui` (branded Pi InteractiveMode) and
  `apps/desktop` (Tauri v2 shell + React chat + Node WS sidecar), sharing one core.
- **Visual harness builder (v3, started)** — a `BuilderPanel` in the desktop app
  (reachable from the chat header) authors a definition from a form: branding,
  system prompt, provider, policy rules, skills, and MCP servers render live as
  `harness.json` + `policy.json` with field-level validation — no hand-edited
  JSON. Backed by a pure, tested model (`builder.ts` + `useBuilder`). A "Save &
  verify" button persists the draft via the sidecar (written under the config dir
  with a sanitized name — no file dialog) and runs doctor, surfacing the verdict;
  the headless path is `openharness materialize <spec> <dir>`. The authoritative
  gate stays `openharness doctor` on the saved files.
- **Governance data plane**
  - `@openharness/mcp` — MCP client (stdio + streamable-HTTP) bridging each MCP tool
    into a Pi tool (`mcp__server__tool`); mandatory servers fail fast; server secrets
    referenced by name (resolved at connect, never baked into the bundle).
  - `@openharness/policy` — deny-by-default first-match rules, secret redaction (args
    and results), model allow/deny, and argument-matching (`tool(*GLOB*)`) against a
    canonical arg string for any tool; enforced in-process via Pi hooks.
  - `@openharness/audit` — hash-chained JSONL, external calls only (never prompts);
    the server retains the authoritative, continuity-checked record. `exportAuditLog`
    / `openharness audit export` produce a compliance bundle for SIEM/retention:
    filtered records + an integrity manifest (chain verified + head hash), gating
    on integrity.
  - `@openharness/bundle` — ed25519-signed `.ohbundle` definition bundles;
    `verifyBundle` / `loadVerifiedDefinition`, fail-closed and path-traversal-safe.
  - `@openharness/server` — thin `GET /bundle` + `POST /audit`, bearer-gated, loopback.
- **The moat — `@openharness/build`** — `openharness build` turns a definition into a
  branded, signed, ready-to-package Tauri app: the app **boots pinned to a verified
  definition** and shows an integrity-refusal screen on tamper or rollback.
- **Policy `ask` UX** in both frontends — a branded approve/deny prompt (TUI dialog;
  desktop modal over the WS), fail-closed.
- **Desktop first-run onboarding (v1.1)** — when no credential resolves for the
  harness's provider, the sidecar emits a recoverable `needs_setup` frame and the
  app shows a paste-a-key panel instead of a cryptic error. The key travels only
  over the loopback, token-gated sidecar socket and is written to the machine-local
  encrypted store (`CredentialManager.addAccount`); `set_credential` → `ready`
  enables chat with no restart. Fail-closed on a blank key; never logged, never
  leaves the machine. The key **survives a restart**: a keyless `accounts.json`
  entry (`persistOnboardedAccount`) references the stored secret, which
  `loadAccounts` resolves on the next launch — so `accounts.json` never holds
  raw key material.
- **v2 remote MCP gateway — end to end** (`@openharness/gateway` + core bridge) —
  the governed pipeline as an MCP server a harness connects to: a pinned virtual
  tool catalog (never proxied live), DPoP-bound gateway tokens, the SAME policy
  engine evaluated server-side (per-principal + argument-level), a KMS-interface
  credential broker resolved only after the allow decision (the gateway holds
  its own per-upstream credential — no token passthrough), a sandboxed connector
  runtime with a per-connector egress allowlist + a forward-proxy tap (the
  Postmark defense, now ACTIVE in a first-party `notify` WRITE connector that
  refuses an unsanctioned field — a silently-injected BCC — before egress)
  alongside a first-party GitHub-read connector, return-path
  redaction, an authoritative hash-chained audit, a fail-closed server-side
  approval queue, and per-user upstream session isolation. The **transport**
  closes the loop: a definition declares a `gateway` (url + pinned pubkey +
  tools); `startGatewayHttp` is a deployable HTTP entry that authenticates every
  request at the edge with DPoP (token + request-bound proof + key-binding, no
  passthrough, no session affinity); and `createLiveSession` bridges the gateway's
  pinned tools into the agent as `mcp__<gateway>__<tool>`, fail-closed at boot
  when a declared gateway is unreachable. Proven over real loopback HTTP.
  Connector/broker sit behind swappable interfaces (an OpenConnector backend can
  slot in later). An adversarial review of the transport then closed three real
  holes: DPoP proofs are single-use (a captured proof can't be replayed — random
  `jti` + a server-side replay guard, 60s window); the pinned server `pubkey` is
  enforced (the client verifies a per-request gateway signature and requires TLS
  off-loopback, so a fake gateway is refused); and the HTTP entry contains
  per-request failures rather than crashing the shared server. It is runnable:
  `openharness-gateway serve <config.json>` boots the whole pipeline from a
  zod-validated config (keys, policy, pinned catalog, connectors) against a
  machine-local encrypted secret store — credentials referenced by name, never
  in the config. Deploy hardening (real IdP/token-exchange, KMS-backed broker,
  containerized connector sandbox) remains.
- **Example harnesses** — `acme-fintech` (deny-by-default, AWS-key redaction),
  `northwind-ops` (ask-on-writes, PII redaction), `meridian-support` (the
  non-technical desktop operator: `bash` denied, ask-on-every-write, heavy PII
  redaction — the example that exercises the desktop approval modal), and
  `acme-gateway` (the v2 moat: a remote `gateway` with a pinned pubkey + a
  version-pinned local MCP server + deny-by-default governed egress).
- **`openharness doctor`** — preflight a definition without building it: on top
  of the loader's structural/reference validation it flags self-consistency
  traps (a model the harness's own policy denies, a missing branding icon, an
  MCP secret in the reserved `api-key:*` namespace, default-deny with no allow
  rule, a mandatory MCP server whose every tool is denied, and any MCP server
  fetched unpinned on launch — across npm (`npx`/`bunx`/`pnpm dlx`/`yarn dlx`),
  PyPI (`uvx`/`uv`), and containers (`docker`/`podman run`, pinned only by an
  `@sha256:` digest since a tag is mutable) — the Postmark-MCP supply-chain risk),
  and MCP egress left ungoverned (a policy that leaves `mcp__*` on default-allow).
  Warnings pass; error-level problems exit non-zero, and `--strict-supply-chain`
  escalates unpinned servers to errors for a CI gate. `openharness build` runs
  doctor as a preflight and refuses to build on any error, so a broken definition
  never ships as a bundle. CI gates every example harness on a clean doctor run.
- **BYO-key** — API keys, gateway subscriptions (OpenCode Go), multi-account rotation.
- **Project** — MIT `LICENSE` + `NOTICE`, a full docs suite (`README`, `ARCHITECTURE`,
  `AUTHORING`, `DEMO`, `ROADMAP`, `vision`, `SECURITY`, `CONTRIBUTING`, `CODE_OF_CONDUCT`,
  `CHANGELOG`), a landing page (GitHub Pages), CI (test + typecheck + a `doctor` gate over
  every example harness), `.nvmrc` + `.editorconfig`, and issue/PR templates.

### Security

- Secrets never land in a committed file, a signed bundle, or the audit log
  (MCP secret indirection; a build key-scan test; redaction both directions).
- Fail-closed everywhere it matters: policy `ask`, missing credentials, a
  tampered/rolled-back/unsigned definition.
- Server-side audit chain verification rejects re-chained / forked / gapped pushes;
  constant-time bearer comparison; anti-rollback `minVersion` on verified boot.
- **Provider-aware credential selection** — `Account` carries a `provider`, and
  `CredentialManager.activeAccount(profile, provider?)` selects/rotates ONLY among
  matching-provider accounts. Under multi-key BYOK, an OpenAI harness can never be
  handed an Anthropic key (cross-vendor secret disclosure); no matching account
  clears the runtime key and yields none — never a different provider's key.
- **Redaction fails closed on audit failure** — a throwing audit sink can no longer
  skip the policy extension's redacted `tool_result` return or a `tool_call`
  block/redaction; the security outcome is applied independent of audit durability.
- **MCP secret namespace guard** — an MCP `secrets` ref in the reserved LLM-credential
  namespace (`api-key:*`) is rejected at connect, so a signed definition cannot name
  an LLM key as an MCP header/env and exfiltrate it to an arbitrary endpoint.
- **Build fails loud on out-of-dir references** — `buildHarnessApp` refuses a
  definition whose `systemPrompt`/`appendSystemPrompt` file, `promptLibrary`, skill
  dir, or project-relative MCP path escapes the definition dir, rather than silently
  shipping a bundle missing those files.
- **Desktop approval modal cannot orphan** — the sidecar emits an `ask_cancelled`
  frame when it finishes an `ask` without a client answer (timeout/disconnect), and a
  stale `ask_response` is a benign no-op (no error bubble). Concurrent `ask`s queue
  and surface one at a time instead of overwriting each other.

### Deferred (roadmap)

Final `tauri build` + fresh-account validation (manual), OS code-signing, remote
MCP gateway + governed credential pooling, a visual builder, the managed cloud.
Design proposals for the two next milestones — v1.1 desktop onboarding and the
v2 remote MCP gateway — are in [`docs/specs/`](docs/specs).
