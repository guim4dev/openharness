# Changelog

All notable changes to OpenHarness. This project adheres to
[Semantic Versioning](https://semver.org) and
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

Work on the `dev` branch since `v0.1.0` (663 tests green). Not yet promoted to a
release tag.

### Changed (BREAKING)

- **A `policy.json` with an argument-content `allow` on a non-`bash` tool now
  fails to load.** The form `tool(<glob>)` matched a blob of ALL argument fields;
  as an `allow` that was fail-open (a disallowed value could be smuggled into
  another field). Migrate such a rule to the new **field-scoped** form
  `tool(<field>=<glob>)` (pins the governed field), or to `deny`/`ask` (the blob
  form is unchanged and safe for those). `bash(<glob>)` allows are unaffected.
  All OTHER v0.1.0 artifacts are format-compatible and need no migration: signed
  `.ohbundle`s still verify (the sign/verify format is unchanged; only the
  anti-rollback comparator gained SemVer pre-release ordering), audit chains still
  verify, the encrypted secret store loads unchanged, and a v0.1.0 `accounts.json`
  migrates as before (the api-key path is byte-for-byte unchanged).

### Added

- **Deploy-hardening seams, config-driven** — the v2 gateway's IdP token exchange
  (RFC 8693 `POST /token`), a KMS-interface credential broker with an ordered
  rotation **pool**, and an **out-of-process connector sandbox** (a warm
  per-(principal, connector) worker) are now selectable from the gateway config
  file, each a provider-agnostic interface + offline reference impl.
- **JWKS IdP verifier** — `tokenExchange` is config-selectable between the static
  single-key (Ed25519) verifier and a **JWKS-fetching** one (`jwksUri`, RS256/ES256
  selected by `kid`, https-only, capped-TTL cache, Node crypto — no new dep), so
  the token-exchange works against real OIDC IdPs (Okta/Entra/Auth0/Google).
- **CLI dual-control** — `openharness-gateway serve` reads per-approver tokens from
  `OPENHARNESS_GATEWAY_APPROVERS` (a JSON identity→token map), so
  `requireSecondPerson` is usable without embedding `startGatewayFromConfig`.
- **Signed-definition update channel** — `openharness update` pulls a newer signed
  bundle from a server, verifies it under the org pubkey against a persisted,
  monotonic anti-rollback **floor**, and writes an accepted newer bundle to the
  updates dir; the desktop app boots pinned to the newest verified bundle ≥ floor.
- **Consumer OAuth accounts** — an `accounts.json` `oauth` block registers a
  loopback **PKCE** auth provider and `openharness login <accountId>` runs the
  flow; tokens land in the encrypted store, only non-secret refs persist.
- **Audit `reconcile`** — `openharness audit reconcile <local> <gateway>`
  cross-checks two chains, verifying both and failing closed on corrupt input.
- **Per-approver dual-control** — `requireSecondPerson` is a real control with
  per-approver tokens (the approver identity is authenticated, never body-supplied),
  alongside the server-side approval admin surface.

### Security

- Five adversarial-review fixes on the second-pass code: an empty-approver-token
  dual-control bypass (HIGH), an `audit reconcile` fail-OPEN on corrupt input
  (CRITICAL), OAuth-endpoint HTTPS enforcement, a tampered-baked-bundle
  anti-rollback floor collapse (now fail-closed), and release env-sealing so a
  preset launch environment can't downgrade the desktop app to an unverified boot
  (HIGH, with an `OH_SEALED` sidecar guard).
- **Desktop launch crash fixed** — resolve `Contents/Resources` from
  `current_exe()` (tolerating a symlinked exe-path ancestor) and probe for `node`
  under launchd's bare PATH, so the packaged app boots from any launch context.
- **Three adversarial correctness sweeps** over the code the trust-boundary
  reviews didn't cover found + fixed **all 37** confirmed bugs (each with a
  regression test), including seven HIGH the passing suite missed: a symlink bypass
  of the loader's file-exfiltration guard (`resolve()` → `realpath()`), a
  materialize atomicity/fail-closed violation, a session `close()` that leaked
  every resource if one teardown step threw, a builder MCP round-trip that dropped
  env/secrets/args/headers, a `SecretStore.open()` that regenerated the key (and
  destroyed every secret) on any non-ENOENT read error, and a JWKS verifier with
  no forgery/fail-open bypass after 43+ PoC attacks. Plus MCP result caps, a
  gateway tool-name guard, redaction of secret object-keys, an atomic secret-store
  flush, a `/bundle` version guard, socket-drop turn termination, and builder
  round-trip/verdict/reselect fixes.
- **Field-scoped policy argument matching** (`tool(<field>=<glob>)`) closes the
  seventh HIGH — an argument-content `allow` over the blob of all fields was
  fail-open (a disallowed value could be smuggled into another field). A content
  `allow` now pins one named field; the loader refuses a non-`bash` blob `allow`.
- **Property/fuzz harness on the policy matcher** (`matcher.fuzz.test.ts`, seeded
  PRNG, no new dep) explores the input space the example suite doesn't: 15k+
  adversarial JSON tool-calls assert the field-scoped `allow` NEVER fires from a
  smuggled value (sibling field, nested/array copy, case-variant key, JSON
  `__proto__`, prototype method-name field), the matcher is total (no throw on
  3000-level nesting → no fail-open in the hook), and the blob deny/ask surface
  stays fail-safe. A "teeth" test proves the smuggled value is reachable and that
  field-scoping is what refuses it.
- **Byte-reproducible signed bundles.** `bundleDefinition` now honors an explicit
  `createdAt` option and the `SOURCE_DATE_EPOCH` reproducible-builds env var; with
  the timestamp pinned, two independent builds of the same definition produce
  identical bytes and an identical signature (files are content-addressed, ed25519
  is deterministic — `createdAt` was the sole non-reproducible field). A recipient
  can cross-verify a distributed bundle against its published source, not just that
  some org key signed it. Default (unpinned) behavior is unchanged.
- **Anti-rollback floor unified across both enforcement stages.** The desktop boot
  verified the bundle twice — stage 1 (`resolvePinnedBundle`) picked the newest
  bundle ≥ the *effective* floor `max(persisted, baked)`, but stage 2 (the sidecar)
  re-verified at only the baked `OH_MIN_VERSION`, a weaker bar. `resolvePinnedBundle`
  now returns that effective floor and `server.ts` threads it into the sidecar's
  `minVersion` (stricter wins), so both stages check against one source of truth and
  a swapped org-signed bundle in `[baked, floor)` cannot slip past the second stage.

### CI / supply chain

- **The project's own CI now meets the standard it sells.** `ci.yml` went from
  ubuntu-only / single-Node / never-builds-the-desktop / unpinned actions to: an
  **OS matrix** (ubuntu + macOS — the launch crash was macOS-specific) × a **Node
  matrix** (the `.nvmrc` floor + the next LTS major), a **desktop-compile job**
  (Vite UI build + `cargo build --release` of the Tauri shell on both OSes; a full
  signed-installer build gated to `main`), and a **supply-chain job** emitting a
  CycloneDX **SBOM** (`npm sbom`, no third-party action) with **SLSA build
  provenance** (`actions/attest-build-provenance`). Every action is **pinned to a
  verified 40-char commit SHA** (each re-checked against its release tag; one
  annotated-tag-object mispin was corrected to the commit), and the workflow runs
  under a least-privilege `contents: read` default token, raising `id-token` /
  `attestations` only in the job that needs them.

### Docs

- `RUNLOCAL.md` verified end-to-end against `dev` (twice); `SECURITY.md` gains a
  Known-limitations section + the gateway's positive invariants; `ROADMAP` and
  `vision` corrected for the shipped OAuth-account path and the built gateway; a
  new **`GATEWAY.md`** deploy/config reference documents every `serve` config key.
- **Signing-key lifecycle & compromise recovery** — `SECURITY.md` now documents
  the operations around the signed channel a turnkey PKI would hide: trust-root
  custody, why rotation is a redistribution event (the root is baked), and the
  ordered three-step compromise recovery — rotate, redistribute, then **reset the
  poisoned floor** (the anti-rollback floor is version-only, not key-scoped, so a
  leaked key that signs version N+50 DoSes the update channel until the floor file
  is cleared). Pinned by a `trust-root change` invariant test: an old-key bundle
  never verifies under a new root even at a higher version, and resolution recovers
  only once the floor is reset. Key-scoped and sealed floors are tracked hardening.

---

## [0.1.0] — 2026-07-14 — initial build

The first end-to-end build: a company can define its own harness and ship it,
governed and signed, to a TUI and a desktop app. 431 tests, MIT, built on
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
  and can REOPEN a saved definition to edit it (round-trip-safe). The headless
  path is `openharness materialize <spec> <dir>`. The authoritative gate stays
  `openharness doctor` on the saved files.
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
  in the config, and populated with `openharness-gateway set-secret` (STDIN, never argv). Deploy hardening (real IdP/token-exchange, KMS-backed broker,
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

OS code-signing/notarization of the desktop shell, the managed cloud, and the
deployment-specific wiring of the gateway seams (a real IdP JWKS, a real
KMS/secrets-manager). Design proposals are in [`docs/specs/`](docs/specs).
(The remote MCP gateway, governed credential pooling, and the visual builder
that earlier drafts listed here all shipped — see Added above and [Unreleased].)
