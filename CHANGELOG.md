# Changelog

All notable changes to OpenHarness. This project adheres to
[Semantic Versioning](https://semver.org) and
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased] — 2026-07-14 (initial build)

The first end-to-end build: a company can define its own harness and ship it,
governed and signed, to a TUI and a desktop app. 245 tests, MIT, built on
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
- **Governance data plane**
  - `@openharness/mcp` — MCP client (stdio + streamable-HTTP) bridging each MCP tool
    into a Pi tool (`mcp__server__tool`); mandatory servers fail fast; server secrets
    referenced by name (resolved at connect, never baked into the bundle).
  - `@openharness/policy` — deny-by-default first-match rules, secret redaction (args
    and results), model allow/deny, and argument-matching (`tool(*GLOB*)`) against a
    canonical arg string for any tool; enforced in-process via Pi hooks.
  - `@openharness/audit` — hash-chained JSONL, external calls only (never prompts);
    the server retains the authoritative, continuity-checked record.
  - `@openharness/bundle` — ed25519-signed `.ohbundle` definition bundles;
    `verifyBundle` / `loadVerifiedDefinition`, fail-closed and path-traversal-safe.
  - `@openharness/server` — thin `GET /bundle` + `POST /audit`, bearer-gated, loopback.
- **The moat — `@openharness/build`** — `openharness build` turns a definition into a
  branded, signed, ready-to-package Tauri app: the app **boots pinned to a verified
  definition** and shows an integrity-refusal screen on tamper or rollback.
- **Policy `ask` UX** in both frontends — a branded approve/deny prompt (TUI dialog;
  desktop modal over the WS), fail-closed.
- **Example harnesses** — `acme-fintech` (deny-by-default, AWS-key redaction),
  `northwind-ops` (ask-on-writes, PII redaction), and `meridian-support` (the
  non-technical desktop operator: `bash` denied, ask-on-every-write, heavy PII
  redaction — the example that exercises the desktop approval modal).
- **`openharness doctor`** — preflight a definition without building it: on top
  of the loader's structural/reference validation it flags self-consistency
  traps (a model the harness's own policy denies, a missing branding icon, an
  MCP secret in the reserved `api-key:*` namespace, default-deny with no allow
  rule, a mandatory MCP server whose every tool is denied). Warnings pass;
  error-level problems exit non-zero. `openharness build` runs doctor as a
  preflight and refuses to build on any error, so a broken definition never
  ships as a bundle. CI gates every example harness on a clean doctor run.
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
