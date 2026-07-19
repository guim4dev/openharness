# OpenHarness — Vision & Knowledge Base

> Living document. Consolidates everything we know and every decision taken so
> far. Update it as decisions change; treat it as the single source of truth for
> *why* the project is shaped the way it is.

Last updated: 2026-07-18 (added related work — §14 OpenWork, our closest analogue /
north star; §15 CodeNomad, a desktop-cockpit UX reference. §14 corrected after
verified deep research: OpenWork's Den control plane IS fully self-hostable — our
wedge is license purity + verifiable governance, NOT self-hosting).

---

## 0. Current state (what's actually built)

On `dev` (with `v0.1.0` tagged on `main`), **665 tests green**, typecheck +
`cargo check` green, and CI hardened + proven green on a real OS/Node matrix
(ubuntu+macOS, desktop compile, SBOM + provenance; the production dependency tree
is `npm audit`-clean). Since 0.1.0, `dev` adds the config-driven deploy-hardening
seams (IdP token-exchange, KMS broker pool, out-of-process connector sandbox), a
signed-definition **update channel** with a persisted anti-rollback floor (wired
into desktop boot), **consumer OAuth accounts** (loopback PKCE + `openharness
login`), **audit reconcile**, **per-approver dual-control**, and a fix for the
macOS desktop launch crash. A cross-cutting
integration test proves MCP + policy + audit compose end-to-end in one live
session, and adversarial review passes hardened the security claims (honest
audit-integrity framing + server-side chain verification, policy fails loud on a
malformed rule, constant-time token). A dedicated review of the v2 gateway
transport then closed three real holes: DPoP proofs are now single-use
(anti-replay), the pinned server `pubkey` is actually enforced (the client
verifies a per-request server signature + requires TLS off-loopback), and the
HTTP entry contains per-request failures instead of crashing the shared server.
A further review of the v2.x/v3 work closed six more: three Postmark-tap bypasses
(array-element, prototype-named key, value-override redirect), an IPv6/bracket
SSRF gap, a replay-guard O(n²) DoS, a docker digest-pin false-negative, and a
visual-builder round-trip that had silently dropped the gateway pin. A review of
the trust-critical core + server then closed five more — the two most serious
being a policy-enforcement fail-OPEN (pathologically-deep tool args overflowed
the arg-matcher and let a denied tool run unblocked; now depth-bounded +
fail-closed) and a build key-leak (the signing key was bundled into the
distributed artifact if placed in the definition dir; now refused) — plus an
audit case-desync fork, a bundle-endpoint DoS, and an unbounded request body. A
final review of the MCP bridge + loader closed one more HIGH — the loader read
any file a definition's `systemPrompt` pointed at, so an unverified definition
could exfiltrate `../../etc/passwd` into the system prompt (now containment-checked)
— plus untrusted-MCP-server hardening (unsafe tool names skipped, results capped,
malformed results guarded, `__` barred from server names). A fifth pass, on the
post-0.1.0 code, closed five more: an empty-approver-token dual-control bypass
(HIGH), an `audit reconcile` fail-OPEN on corrupt input (CRITICAL), a
tampered-baked-bundle anti-rollback floor collapse, OAuth-endpoint HTTPS
enforcement, and release env-sealing so a preset launch environment can't
downgrade the desktop app to an unverified boot (HIGH). Across five review
passes, 18+ real bugs — a CRITICAL and several HIGH — were found and fixed with
regression tests.
Packages/apps:

- **`@openharness/definition`** — HarnessDefinition (dir + `harness.json` + optional
  `policy.json` + `mcp` + `gateway` sections), zod-validated, fail-fast loader.
  `systemPrompt`/`appendSystemPrompt` accept a plain file path (default) or a
  `lib:<name>` ref resolved against an optional `promptLibrary` dir — see
  `@openharness/prompts`. `scaffoldHarness` writes a starter; `writeHarnessDefinition`
  materializes a COMPLETE definition from in-memory objects (schema-validated,
  fail-closed) — the "ship" primitive behind the visual builder and the headless
  `openharness materialize` command.
- **`@openharness/prompts`** — a curated PromptLibrary: a dir of `.md` files with
  YAML frontmatter `{ name, description }`; `loadPromptLibrary` + `resolvePrompt`
  (throws, listing available names, on an unknown ref).
- **`@openharness/credentials`** — encrypted secret store, multi-account rotation/
  failover, pluggable AuthProvider registry, api-key provider (covers OpenCode Go).
- **`@openharness/core`** — cross-platform per-identifier paths, `createLiveSession`
  (drives a real in-process Pi session, streams tokens), verified-load path
  (`loadVerifiedDefinition`), `createOpenHarnessAuthStorage`, `loadAccounts` (BYO-key),
  the policy enforcement extension wiring, `runDoctor` (definition preflight), and the
  `openharness chat/init/doctor/keygen/bundle/build/serve` CLI.
- **`@openharness/mcp`** — MCP client (stdio + streamable-HTTP) bridging each MCP tool
  into a Pi tool (`mcp__server__tool`); mandatory servers fail fast. The enforcement seam.
- **`@openharness/policy`** — deny-by-default first-match rules + secret redaction +
  model allow/deny; enforced in-process at `tool_call`/`tool_result`/`before_provider_request`.
- **`@openharness/audit`** — hash-chained JSONL, external calls only (no prompts),
  emitted from the same code path as enforcement; `verifyAuditLog` catches accidental
  corruption + naive edits (keyless/genesis-anchored — the server's retained per-source
  HEAD is the real tamper-evidence anchor, rejecting re-chained/forked/gapped pushes).
  `exportAuditLog` (+ `openharness audit export`) produces a compliance bundle for
  SIEM/retention: filtered records plus an integrity manifest (chain verified + head
  hash), exiting nonzero when integrity fails so a pipeline can gate on it.
- **`@openharness/bundle`** — ed25519-signed `.ohbundle` definition bundles;
  `verifyBundle`/`loadVerifiedDefinition` (fail-closed, path-traversal-safe).
- **`@openharness/server`** — thin `GET /bundle` + `POST /audit`, bearer-gated, loopback.
- **`@openharness/build`** — `openharness build`: a definition → a branded, signed,
  ready-to-package Tauri project (templated conf, baked signed bundle + org pubkey +
  esbuilt single-file sidecar; main.rs resolves resources via `resource_dir()` in
  release). Committed key-scan proves no private key is ever baked.
- **`apps/tui`** — branded entry over Pi's InteractiveMode. **`apps/desktop`** — Tauri v2
  shell + React chat + Node WS sidecar; **boots pinned to a signed definition** and shows
  an integrity-refusal screen on tamper; per-identifier data isolation; real CSP.

Demo proven end-to-end (see `docs/DEMO.md`): build two branded, isolated apps → verify
→ flip one byte → integrity refusal. **Done:** walking skeleton (4 phases) + governance
data plane (5) + moat build pipeline (M1–M3), plus `openharness init`/`doctor`
(scaffold + preflight, doctor also gating `build` and CI), a third example harness
(`meridian-support`, the non-technical desktop operator), **v1.1 first-run desktop
onboarding** (in-app BYO-key: a recoverable `needs_setup` → paste-a-key written to
the local encrypted store → `ready`, no restart), and the **v2 remote MCP gateway**
(`@openharness/gateway`, now end to end). The CORE is the governed pipeline as an
MCP server — pinned catalog, DPoP tokens, server-side PDP, post-decision credential
broker, sandboxed connector runtime + egress/tap (the Postmark defense is active
in a `notify` write connector that blocks an unsanctioned BCC before egress) +
a GitHub-read connector,
return-path redaction, authoritative audit, fail-closed approval, per-user
isolation. The **TRANSPORT** now closes the loop: a definition declares a `gateway`
(url + pinned pubkey + tools); a deployable HTTP entry (`startGatewayHttp`)
authenticates every request at the edge with DPoP (token + request-bound proof +
key-binding, no token passthrough, no session affinity); and core bridges the
gateway's pinned tools into the live session as `mcp__<gateway>__<tool>`,
fail-closed at boot when the declared gateway is unreachable. Proven over real
loopback HTTP: an allowed call runs through the full pipeline (audited), a client
without DPoP is refused at the edge, a denied tool never reaches the upstream.
It is **runnable**: `openharness-gateway serve <config.json>` boots the whole
pipeline from a zod-validated config (keys, policy, pinned catalog, connectors)
against a machine-local encrypted secret store.
The **gateway deploy hardening** seams are now built too, each provider-agnostic
(interface + offline reference + tests): IdP **token exchange** (OAuth 2.1 /
RFC 8693 `POST /token` → DPoP-bound token, `IdpVerifier` seam); a **KMS
credential broker** (`KmsBrokerStore` over a secrets-manager + KMS-decrypt seam,
`LocalKms` reference, no long-lived plaintext); an **out-of-process connector
sandbox** (warm per-principal worker process, own memory + crash domain,
`SandboxHost` seam); and **artifact attestation** (`verifyProvenance` — real
DSSE + in-toto/SLSA, wired into `doctor`). What remains is a deployment's own
wiring (which IdP/KMS/runtime) plus the Sigstore key-discovery for attestation.
**Deferred:** final `tauri build` + fresh-account validation (manual); OS
code-signing/notarization; the deployment-specific gateway wiring (a real IdP
JWKS, a real KMS/secrets-manager) + Sigstore key-discovery for attestation; the
managed cloud. (The visual builder shipped as a v3-started `BuilderPanel` — see
above; OpenConnector §13 may back the connector layer once mature.)

---

## 1. One-liner

A platform for companies to **build their own custom AI harnesses** — defined
once, shipped as both a **TUI** (technical users) and a **desktop app**
(non-technical users) — that centralizes how agents work in an org **without the
org losing control**. Self-hosted, local-first, open source.

## 2. The thesis / bet

- **LLMs are becoming a commodity.** Models get cheaper, more interchangeable,
  and increasingly runnable locally. Betting the product on a specific model or
  API is betting on a depreciating asset.
- **The durable value is the harness**: the skills, tools, policies, prompts,
  memory, credentials management, and the governance layer around them.
- OpenHarness **owns the harness layer and stays neutral on the model.** A user
  should be able to plug in an API key, a consumer subscription (ChatGPT/Claude
  Pro), or eventually a local runtime — and the harness doesn't care.

## 3. What we are building on: Pi

[`earendil-works/pi`](https://pi.dev) — researched 2026-07-13.

- **"Minimal agent harness"** in **TypeScript/Node**, distributed on npm.
- **License: MIT** → clean to fork and own.
- **Four operational modes**, all from one core:
  1. Interactive **TUI**
  2. **print / JSON** output
  3. **JSON-RPC** protocol
  4. **Embedded SDK** usage
  → This is why we don't need to "wrap a terminal in a window": a desktop GUI can
  drive the same core over JSON-RPC / SDK. TUI and desktop are two clients of one
  core, which is already how Pi is designed.
- **Extensibility is the whole philosophy.** First-class concepts:
  - **Extensions** — TypeScript modules with keyboard shortcuts, commands, and
    lifecycle event access. Known hooks (from the Superpowers Pi package):
    `resources_discover`, `session_start`, `context` (injects messages into
    provider context), `session_compact`, `agent_end`.
  - **Skills** — capability packages (instructions + tools).
  - **Prompt templates** — reusable Markdown prompts.
  - **Themes**.
  - **Package ecosystem** — third-party packages via npm or git; a package
    manifest lives in `package.json` (`pi.skills`, `pi.extensions`, keyword
    `pi-package`).
- **15+ providers** (Anthropic, OpenAI, Google, Azure, Bedrock, Mistral, Groq,
  …). Mid-session model switching. **All via API key.**
- Sessions stored under `~/.pi/agent/sessions`.
- **Deliberately absent** (Pi calls these "extension opportunities," not gaps):
  native **MCP support**, built-in **sub-agents**, **permission popups**, **plan
  mode**, **to-do**, background bash.

### Why Pi's absences are good for us

Almost everything we want is **greenfield** — we're not fighting existing wiring:

- No native MCP → we introduce MCP to the harness ourselves, **already routed
  through our proxy by design**. Nothing to intercept or retrofit.
- No permission popups / policy → we add policy enforcement cleanly.
- No governance / auth / subscription → that's precisely our value-add.

The **only** thing that genuinely requires touching Pi's core is the
**credential / provider layer** (consumer-subscription OAuth + multi-account
rotation). That is the concrete justification for a fork over a pure extension.

## 4. Product decisions (brainstorming log)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Meta-layer over an existing harness**, not a runtime from scratch. | Avoids reinventing the agent loop — the most expensive subsystem. Ship value fast. |
| D2 | **Domain-agnostic by design.** `harness = prompts + tools + policies + UI`; coding is just one template. | Matches "centralize *all* the work," not just engineering. More elegant abstractions. |
| D3 | **Fork Pi and own the code** (surgical). Keep as much as possible as packages/extensions *inside* the fork; touch core only for the provider/credential layer. | Full control for the 3 hard features (subscription rotation, transparent MCP proxy, consumer OAuth) while minimizing divergence from upstream. |
| D4 | **Desktop = real GUI for non-technical users**, driven by the shared core (JSON-RPC/SDK) — not a terminal in a window. TUI and desktop share one core. | "The version with the best experience"; non-technical people must be first-class. Pi's 4 modes make this native. |
| D5 | **First sub-project = walking skeleton, local-only.** | Proves the spine ("one definition → two frontends") + a daily-use hook, with zero server dependency. De-risks the hardest integration first. |
| D6 | Project name: **OpenHarness** (`openharness`). | User's choice. |
| D7 | **Auth is a pluggable `AuthProvider` abstraction** (opencode-style). v0 supports **OpenCode Go** (API key + baseURL) and **ChatGPT/Codex** (OAuth PKCE) from day one; new subscriptions are new plugins. | User wants Codex + OpenCode Go supported first, abstracted so more subscriptions slot in. |
| D8 | **`chatgpt-oauth` ships as personal BYO-account only, with an explicit ToS disclaimer.** Enterprise-recommended providers: OpenCode Go, Claude Max, API keys. | OpenAI restricts ChatGPT-subscription tokens to "personal development use only; not for commercial/multi-user." Ship it, but honestly. |
| D9 | **OpenHarness *is the harness* — NOT a meta-harness.** We build on/extend Pi to BE one company-brandable, self-hosted, distributable harness that a company creates and deploys to its own employees. We do NOT orchestrate multiple harnesses underneath, and we do NOT layer on top of a meta-harness (e.g. Omnigent — see §11). ("Meta-layer over Pi" in D1 means we extend Pi to be a harness, not that we orchestrate many.) | The value is in *being* the harness employees use — branded, governed, distributed — one layer below the meta-harness category. A layer above the meta layer would be redundant. Validates the Pi-based build. |
| D10 | **Governance = a data plane first, server dumb + last.** Enforcement lives in-process in the harness via Pi's `tool_call`/`tool_result`/`before_provider_request` hooks; the server is initially just a signed-bundle host + audit sink. (Advisor: Fable.) See `docs/specs/2026-07-13-governance-dataplane-design.md`. | Local-first needs offline enforcement; Pi's hooks are the only seam that sees every call and can't be bypassed by the model. A server-first control plane would govern a data plane that doesn't exist (Pi has no MCP yet). |
| D11 | **NEVER pool consumer OAuth subscriptions (Claude Pro/ChatGPT) across users.** Multi-account pooling/rotation is for **org API keys / enterprise seats only**; a consumer subscription = a single personal user. | Pooling consumer subscription tokens across employees violates provider ToS and gets the customer banned. Draw the line before a design partner builds on the wrong side (refines D8). |
| D12 | **v1 targets technical employees** (engineers/data/ops). Non-technical desktop UX is a later epic — but design `policy.json`'s `ask` semantics now so the GUI ask-dialog is a renderer, not a redesign. | Pi is a coding agent (bash/repo model); claiming non-technical-first now is a positioning↔implementation mismatch that kills demos. |

## 5. Governance model (what "not losing control" means)

The control point is a **proxy**, not a spy on the user's machine.

- **Everything external goes through our proxy/server.** Every MCP tool and
  external system call is routed through an OpenHarness proxy. That proxy is
  where audit, policy, and the future automation-hosting hook live.
- **Audit is scoped to external calls only** (via the proxy) — not full
  keystroke/agent-action surveillance. Privacy-respecting by design.
- **Policy enforcement**: which tools/MCP/models are allowed, permission gating,
  secret redaction, command allowlists — the org defines, the harness applies.
- **Mandatory MCPs and mandatory skills**: an org can require certain MCP servers
  to always be connected and certain skills to always be present.
- **System-prompt control + a shared prompt library** the org curates. **Implemented:**
  a `promptLibrary` dir of named, frontmatter-tagged `.md` prompts; a definition
  references one by name (`systemPrompt: "lib:<name>"`, optionally layering
  org-specifics via `appendSystemPrompt`) instead of inlining the text — the
  prompt layer is centrally curated and swappable without touching the harness
  that consumes it. `harnesses/acme-fintech` demonstrates it (base + append);
  `harnesses/example` / `harnesses/northwind-ops` keep the plain-path form
  working unchanged. The library must live inside the definition dir to travel
  in the signed bundle (`@openharness/bundle` only walks the definition root).
- **Distribution / identity**: only approved builds run; SSO decides who uses
  which harness; centralized update/rollback of shipped TUI + desktop versions.
- **LLM gateway is optional.** Ideally users connect to a provider locally. A
  central gateway (keys, budgets, rate limits) can exist but is not the default —
  consistent with the commoditization bet.
- **Credentials ≠ API keys.** A pluggable **`AuthProvider`** abstraction (see §10)
  lets users register API keys, gateway subscriptions (OpenCode Go), and consumer
  OAuth subscriptions (ChatGPT/Codex, Claude Pro/Max), register **multiple
  accounts**, and have the harness **rotate / fail over** across them as limits are
  hit — rotation is orthogonal to credential kind. ChatGPT-subscription auth is
  personal-BYO-only with a ToS disclaimer (D8).
- **Strategic wedge**: because every MCP call already flows through our proxy,
  the proxy becomes the natural place to later let users **build automations
  inside the harness and deploy them to our server.**

## 6. Subsystem decomposition

The full vision is too large for one spec. Independent subsystems, each with its
own spec → plan → implementation cycle:

1. **Core (fork of Pi)** — Pi + surgical provider-layer patch (consumer OAuth
   subscriptions + multi-account rotation/failover). Embeddable as shared core.
2. **Harness Definition** — the declarative artifact a company "builds": system
   prompts (+ library), mandatory MCPs, mandatory skills, policies, branding,
   provider config. This is what becomes the TUI + desktop.
3. **Control plane (self-hosted server + MCP proxy)** — proxies external calls,
   audits (external only), enforces policy, distributes definitions, SSO /
   identity, approved builds, and the future automation-hosting hook.
4. **TUI** — the forked Pi TUI, branded (technical users).
5. **Desktop GUI** — Tauri/Electron client over the shared core via JSON-RPC
   (non-technical users), branded, auto-update.
6. **Builder + packaging pipeline** — how an author defines a harness and
   builds/signs/distributes the TUI + desktop artifacts.
7. **Cloud version** — explicitly **out of scope for now** (self-hosted first).

### Build order (current)

1. **Walking skeleton (local-only)** ← the first slice we design next.
2. Control plane (server + MCP proxy + audit + policy + distribution).
3. Builder + packaging pipeline.
4. Cloud.

## 7. First slice: Walking skeleton (local-only)

Goal: prove the product's spine end to end, locally, with something usable.

Scope (to be detailed in `docs/specs/2026-07-13-walking-skeleton-design.md`):

- Fork Pi.
- A **minimal Harness Definition** (branding + system prompt + one mandatory
  skill + provider config).
- It loads in the **forked TUI**.
- A **minimal desktop GUI** (Tauri, over JSON-RPC) loads the **same** definition
  and gives a non-technical chat UX.
- The daily-use hook: a **credential/subscription manager** — consumer OAuth +
  multiple accounts + rotation/failover.
- **No server yet.** The MCP proxy and control plane come in slice 2.

Explicitly deferred out of the skeleton: MCP proxy, central audit, policy
enforcement server, SSO, approved-build distribution, packaging pipeline, cloud.

## 8. Glossary

- **Harness** — the whole configured agent experience: prompts + skills + tools
  (MCP) + policies + credentials + UI. What a company "builds" on OpenHarness.
- **Harness Definition** — the declarative artifact describing a harness.
- **Core** — the forked Pi engine, embeddable, driving both frontends.
- **Control plane** — the self-hosted server: MCP proxy, audit, policy,
  distribution, identity.
- **MCP proxy** — the OpenHarness component every external/MCP call routes
  through; the seat of governance and the future automation host.
- **Provider** — a source of model inference (API key, consumer subscription, or
  local runtime).

## 9. Open questions (to resolve in later specs)

- Exact **Harness Definition format** (a Pi package? a superset manifest? a
  git-versioned repo?). Skeleton will pick a minimal v0 and iterate.
- Desktop shell: **Tauri vs Electron** (leaning Tauri: lighter, Rust, better for
  a signed distributable).
- How the shared core is exposed to the desktop: **long-lived JSON-RPC daemon vs
  embedded SDK in-process** (skeleton will choose one and document why).
- Fork sync strategy with upstream Pi (how to stay close to `main`).
- Consumer-subscription OAuth ToS per provider (ChatGPT resolved in D8; Claude
  Max / others to assess as they're added).

### Format gaps surfaced by realistic harnesses

Building the checked-in `acme-fintech` / `northwind-ops` definitions surfaced
three gaps in the harness/policy format — all three now CLOSED. See the
governance spec for detail.

1. **MCP secret indirection — CLOSED.** An MCP server's real secret (DB password,
   API token) must never live in `harness.json` / the signed `.ohbundle`. Added
   `mcp.servers.<name>.secrets` mapping an ENV VAR (stdio) or HEADER (http) name to
   a credential **ref name** — resolved at connect-time from the machine-local
   `SecretStore`, fail-closed. Only the ref travels, mirroring `credentialProfile`.
2. **Arg-level policy matching beyond bash — CLOSED.** Parameterized
   `name(<glob>)` matching now works for ANY tool, not just `bash`. For a
   non-bash tool the inner glob matches the **canonical arg string** — every
   string value in the input, gathered recursively through nested objects and
   arrays and joined by newline — **case-insensitively** and substring-style
   (`*DELETE*` catches `delete`/`Delete` in any field). This is the fail-SAFE
   choice: a sensitive keyword anywhere in the args makes the rule fire, so
   `northwind-ops` can `deny` `mcp__back_office__write_query(*DROP*)` /
   `(*TRUNCATE*)` / `(*ALTER*)` and `ask` on `(*DELETE*)` / `(*UPDATE*)`. `bash`
   keeps matching its `command` case-sensitively. `parsePolicy` still rejects a
   genuinely malformed match (empty tool name, unbalanced parens) so it can't
   become a silent no-op.
3. **HTTP transport auth — CLOSED.** The http MCP transport had no auth field.
   Added literal `mcp.servers.<name>.headers` plus folding `secrets` into http
   (HEADER name -> credential ref), set on the client's request headers at connect.

## 10. Subscription-auth landscape (research, 2026-07-13)

How existing tools authenticate to subscriptions — the input to the `AuthProvider`
abstraction. OpenCode is the reference for the abstraction itself.

- **OpenCode Go** — a low-cost subscription ($5 first month, then $10/mo) for
  popular open coding models. Auth is a **plain API key** (sign in at OpenCode Zen
  → subscribe → copy key → paste). Calls route to a gateway
  `https://opencode.ai/zen/go/v1/{chat/completions,messages}` — **OpenAI- and
  Anthropic-compatible**. → trivial for us: `api_key` + custom `baseURL`.
- **OpenCode Zen** — sibling pay-as-you-go gateway for curated models (not a flat
  subscription). Same API-key + gateway model.
- **ChatGPT / Codex subscription** — **OAuth PKCE**: local callback (port 1455),
  client id `app_EMoamEEZ73f0CkXaXp7hrann`, `auth.openai.com/oauth/{authorize,
  token}`, auto-refresh, creds in `~/.codex/auth.json`; device-code flow for
  headless. The token calls the **ChatGPT backend** (not the standard OpenAI API):
  needs an SDK→Codex format transform and a **`store: false`** requirement. ToS:
  **personal use only, not commercial/multi-user** (see D8).
- **Claude Pro/Max** — OAuth via browser login (or `claude setup-token` → a
  1-year `CLAUDE_CODE_OAUTH_TOKEN`). OAuth-subscription credential type.
- **OpenCode's auth abstraction** (our model): provider-agnostic `Auth` namespace,
  three credential types (`oauth` {access,refresh,expires,accountId,enterpriseUrl}
  | `api_key` {key} | well-known), stored in `auth.json` (0600). OAuth/PKCE is
  **delegated to plugins**, not hardcoded: two-phase `authorize()` → {url,
  instructions, method} then `callback()` → credential. Model metadata via
  **models.dev**; calls via the **Vercel AI SDK**; a provider transform layer
  normalizes messages.

### References

- OpenCode Go — https://opencode.ai/docs/go
- OpenCode Zen — https://opencode.ai/docs/zen/
- OpenCode auth/architecture — https://deepwiki.com/sst/opencode/4.2-authentication-and-authorization
- OpenCode providers — https://opencode.ai/docs/providers/
- Codex auth — https://learn.chatgpt.com/docs/auth
- opencode Codex-auth plugin (reference impl) — https://numman-ali.github.io/opencode-openai-codex-auth/
- Claude Code authentication — https://code.claude.com/docs/en/authentication
- Pi — https://pi.dev

## 11. Related work: Omnigent — and why we're a different category (2026-07-13)

[Omnigent](https://omnigent.ai) (Databricks + Neon, Apache-2.0, **Python 3.12+**,
GitHub `omnigent-ai/omnigent`, alpha) is a **meta-harness**: a control plane that
**orchestrates many harnesses** — Claude Code, Codex, Cursor, OpenCode, Hermes,
**Pi**, and custom YAML agents — with meta-layer policies (stateful, 3-level:
server/agent/session; cost budgets; OS sandboxing), live shared sessions, and
surfaces over terminal + web + macOS native + mobile + REST.

**Category difference (the key point).** Omnigent sits *above* many harnesses.
OpenHarness *is* one harness (built on Pi) that a company brands and ships to its
employees — one layer *below* Omnigent's category. We are not competing for the
same slot; an OpenHarness-built harness could itself be a target Omnigent wraps.
We do **not** fork Omnigent, sit on top of it, or become a meta-harness (D9).

**Where we differ / our moat:**
- **A brandable, distributable harness *product*** (own TUI + desktop, mandatory
  skills/MCPs, curated prompt library, self-hosted) — Omnigent runs YAML agents on
  *its* platform; white-label distribution isn't its focus.
- **Credential pooling + multi-account rotation/failover** — Omnigent supports
  subscriptions (via the official `claude`/`codex` CLIs) but not multi-account
  rotation for one provider. We built this in Phase 1.
- **Cross-platform native desktop for non-technical users** — Omnigent's desktop is
  a macOS-only web wrapper; ours targets Windows/Linux/macOS natively.

**What to borrow (ideas, not architecture):**
- Their **policy model** (stateful, data-centric, enforced at the layer not via
  prompts, 3-level stacking) — a strong reference for our future control plane.
- **Subscription auth via the official `claude`/`codex` CLIs** — a possibly
  simpler/safer (ToS) alternative to raw OAuth PKCE for the personal-subscription
  path.
- **Declarative agent config** (their `config.yaml`) validates our `harness.json`.

### References (Omnigent)

- Site — https://omnigent.ai · Custom agents — https://omnigent.ai/docs/use/custom-agents
- GitHub — https://github.com/omnigent-ai/omnigent
- Databricks blog — https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents

## 12. Related work: Odysseus — and why we're a different layer (2026-07-14)

[Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) (PewDiePie's,
Python backend + JS frontend, Docker Compose, ~82.7k stars) is a **self-hosted,
single-user AI *workspace***: a monolithic local hub bundling chat, agents, deep
research, docs, email, calendar, and notes, over **MCP, tools, shell, skills,
memory, and local/API models**. It's a rich end-user product you run for
yourself.

**Category difference (the key point).** Odysseus is an opinionated *product for
one self-hosting individual*; OpenHarness is a domain-agnostic *substrate a
company brands, governs, and distributes to many employees*. Odysseus has no org
layer — no deny-by-default policy at the tool seam, no external-call audit, no
MCP proxy, no credential pooling/rotation, no signed/pinned distribution. It is
an example of **what a company could build *on* OpenHarness**, not a competitor
to the substrate; the same primitives (MCP, skills, memory, local models) sit a
layer below what it assembles.

**What it validates for us:**
- **Strong demand for self-hosted, OSS, local-first AI** (~82.7k stars) — exactly
  our positioning; the gap it leaves (multi-employee, governed, brandable,
  auditable) is our wedge.
- **The non-technical desktop thesis** — its breadth (email/calendar/docs/research
  in a GUI) is a catalog of what a rich harness for non-technical users can offer,
  reinforcing the v1.1 desktop onboarding / GUI direction.

**Anti-lesson (what NOT to copy):**
- **Monolithic "bundle everything."** Odysseus embeds email/calendar/notes into
  the product. For us those are *harness content*, never the substrate — keep the
  core thin and domain-agnostic (same principle as "feature-specific logic lives
  in the harness, not the core"). A company builds its own Odysseus-shaped harness
  on top; we don't grow one into the platform.
- **Model-serving opinion.** Its hardware-aware "Cookbook" picks/serves local
  models; we stay model-neutral (the bet: models commoditize). A "which
  model/runtime" helper is a legitimate *harness-author* aid, not core.

### References (Odysseus)

- GitHub — https://github.com/pewdiepie-archdaemon/odysseus

## 13. Related work: OpenConnector — a candidate COMPONENT for the v2 gateway (2026-07-14)

[OpenConnector](https://github.com/oomol-lab/open-connector) (oomol-lab,
TypeScript, self-hostable — Node/Docker/Cloudflare Workers/Fly; SQLite/D1) is an
**open-source connector gateway for AI agents**: a credential/authorization
**broker** between agents and **1,000+ SaaS providers / 10,000+ prebuilt
actions**, exposed over MCP (`/mcp`), HTTP/OpenAPI, an SDK, and a CLI. Users
connect an account once; agents discover + execute actions **without ever seeing
raw credentials** (server-side API-key/OAuth handling, token refresh,
per-connection scope + allow/block policy, redacted run logs, persistent audit).

**Unlike Omnigent (§11) and Odysseus (§12), this is not a different category —
it is almost exactly our v2 gateway's connector/credential-broker layer, already
built.** That makes it a candidate **build-on component**, not a competitor.

**The compelling split — delegate the connector layer, keep the governance layer:**
- **Delegate to OpenConnector:** the credential broker + OAuth flows + the
  1,000+ provider/action catalog + execution. We will never hand-build 1,000
  connectors (our v2 plan ships *one*, GitHub-read, to prove the shape). Its
  "agents never see secrets" broker model is aligned with our **no-token-
  passthrough** invariant (verify, don't assume — see diligence).
- **OpenHarness keeps (its differentiated governance the broker doesn't provide):**
  the **signed definition + pinned virtual catalog** (supply-chain: what the
  org's branded harness exposes, cryptographically pinned — OpenConnector has no
  signed-distribution story); the **same policy engine as local** (deny-by-
  default, argument-level, per-principal) enforced consistently client+gateway;
  the **hash-chained audit cross-checked with the harness's local chain**;
  **DPoP-bound harness identity**; and the whole *company-brands-and-ships-a-
  governed-harness-to-employees* product. OpenConnector becomes the execution +
  credential + catalog layer **beneath** OpenHarness's governance + distribution.

**Diligence before betting (infra decision — evidence first):** verify maturity
(prod-readiness, issue backlog, release churn, real multi-tenant use); confirm it
truly brokers (never forwards an inbound token — no confused deputy); confirm the
self-hosted path is first-class (not a funnel to the hosted SaaS); check the
license; and confirm its per-connection policy composes with — doesn't replace —
our arg-level/per-principal policy. Default skeptical about adopting a core
dependency that holds every org credential.

**Impact on the in-progress v2 build:** the gateway I'm building is mostly the
**governance layer** — DPoP auth, the PDP (shared policy engine), the pinned
catalog, return-path redaction, the authoritative audit chain, fail-closed
approval, per-user session isolation. That stands **regardless**. Only the
**credential broker** (`KmsStore`) and **connectors** (the one GitHub-read
adapter) overlap OpenConnector; if we integrate, those become a thin
**OpenConnector adapter** behind the same `KmsStore`/`Connector` interfaces
(designed to be swappable for exactly this reason) rather than our own KMS +
hand-built connectors. No governance work is wasted.

### References (OpenConnector)

- GitHub — https://github.com/oomol-lab/open-connector

## 14. Related work: OpenWork — the closest analogue, our north star (2026-07-17)

[OpenWork](https://github.com/different-ai/openwork) (Different AI, Inc., TypeScript,
~17k stars, `different-ai/openwork`, shipping fast — v0.17.32 with ~2k releases as
of 2026-07-17) is "**a free, open-source desktop app made for sharing AI
workflows**" — "an **open-source alternative to Claude Cowork and Codex** for
macOS, Windows, and Linux," **powered by opencode**. You run agents, skills, and
MCPs locally in one click; you can also add **one OpenWork MCP** (remote server at
`api.openworklabs.com/mcp/agent`, exposing `search_capabilities` +
`execute_capability`) into Claude Code, Cursor, Codex, or ChatGPT and reuse the
same skills/MCPs across every tool. BYO keys, 50+ LLMs. Its distribution primitive
is a killer: **package your entire setup — skills, MCP servers, config — into a
single link** teammates import in one click ("OpenWork Connect"). The org layer,
**"OpenWork Den," is "the control plane for managing OpenWork across a team or
organization"**: provider provisioning + access control, member/team management,
**desktop policies**, local-model restrictions, **app version control**, and a
**skill/plugin marketplace with role-based assignment**. License is **dual — MIT for
the bulk, but the *entire* `/ee` tree is Fair Source**: all of the Den control plane
(`den-api`, `den-controller`, `den-web`, `den-worker-proxy`/`-runtime`,
`den-admin-mcp`, `den-db`…) lives under `/ee` at **FSL-1.1-MIT** (Functional Source
License — no competing commercial use, internal use permitted, auto-converts to MIT
on the 2nd anniversary of each release). **Crucially — and this refuted our first
read (verified 2026-07-18, repo docs + a live Helm chart) — the Den control plane is
fully self-hostable, NOT SaaS-only**: an official chart
(`oci://ghcr.io/different-ai/charts/openwork-ee`, real on GHCR, 32 tags 0.17.2→.32)
+ Docker packaging deploy Den web + controller (+ optional inference) into the
company's own VPC/cluster, with agent **API + MCP traffic routed through the
customer's own Den origin** (`<baseUrl>/api/den/…`) — no OpenWork cloud in the loop,
plus a documented **no-egress** config for isolated clusters. In desktop mode files
stay local and prompts go straight to the chosen LLM provider. OpenWork Cloud
(`api.openworklabs.com`, optional sandboxed workers) is the *hosted option*, not the
only one. Priced free desktop → Team Starter ($10/seat/mo after 5 free) → Enterprise
(SSO + BYO inference).

**Category note (the key point — inverted from §11–13).** Unlike Omnigent (a
meta-harness *above* us), Odysseus (a single-user product *on* us), or OpenConnector
(a component *beneath* us), **OpenWork is the same category and the same product
shape we are building** — an open-source, brandable/shareable harness a team runs
as a **desktop app**, running **skills + MCPs**, on a **minimal TS engine** (opencode
↔ our Pi fork), with an **org control plane** (policies, versioning, a
skill/plugin marketplace, RBAC) and **one-click distribution to teammates**. The
convergence is near 1:1 and independent (they ship on opencode; we forked Pi). This
is validation, not threat: **it proves the exact product we're betting on has real
demand (17k stars, an enterprise tier, a fast release cadence) — and it is our
north star for product/UX/distribution.**

**What to borrow (product & UX — study it directly):**
- **The one-link setup primitive.** "Package your entire setup → a single link →
  one-click import" is the distribution UX to beat. Our verifiable analogue already
  exists — the **signed `.ohbundle`** — but their *frictionlessness* (a link, not a
  file + a pubkey) is the bar. Close the gap without dropping the signature/pin.
- **Harness-as-an-MCP.** OpenWork exposes *itself* as one remote MCP
  (`search_capabilities`/`execute_capability`) that plugs into any other harness.
  Our v2 gateway is already an MCP server — making an OpenHarness-built harness
  **consumable from Claude Code/Cursor/Codex the same way** is a cheap, high-leverage
  surface we should consider (it turns every governed harness into a drop-in tool
  for the harnesses people already use).
- **The "Den" feature checklist** (provider provisioning, desktop policies, app
  version control, marketplace + role-based assignment) is a concrete, market-tested
  spec for what our own org control plane should cover — a direct reference for the
  future control plane (cf. §11's policy-model note).
- **BYO-keys + 50+ LLMs + optional sandboxed cloud workers** — same posture we hold
  (provider-neutral, local-first, cloud optional).

**Where we differ / our moat — NOT self-hosting (they have it too).** The naïve
wedge ("they're SaaS, we're self-hosted") is **dead**: verified against the repo + a
live Helm chart, OpenWork self-hosts its whole Den control plane, keeps traffic on
the customer's infra, and even documents a no-egress path. Our real, defensible
differences are three:
- **License purity.** OpenHarness is **MIT everywhere, including the governance
  layer**. OpenWork's *entire* Den/org layer is **FSL-1.1-MIT Fair Source** —
  source-available, non-compete-restricted, MIT only 2 years later. For the buyer
  who wants to *own it end to end* with no asterisk on the exact part that matters
  (governance), that gap is real and permanent-by-design on our side.
- **Verifiable governance = enforcement, not administration.** Signed/pinned
  definition bundles + **integrity-refusal on tamper**, **hash-chained audit anchored
  server-side**, and a gateway that re-decides policy **server-side** with a
  **no-token-passthrough DPoP credential broker** (agents never see raw secrets).
  OpenWork's Den *administers* (RBAC, provisioning, desktop policies — a preference a
  patched client can ignore); we make the config cryptographically un-forgeable and
  the boundary hold even against a hostile endpoint. No visible OpenWork equivalent
  for signed distribution or tamper-evident audit (see Diligence).
- **White-label as an output.** `openharness build` → the company's *own* branded,
  signed app; OpenWork distributes OpenWork.

**Anti-lesson (what NOT to copy):** the **Fair-Source open-core split** — the whole
governance/control-plane layer under FSL-1.1 in `/ee` while the thin engine stays
MIT ("open core, source-available control plane, MIT someday"). Our bet is the
opposite — **the governance layer IS the open (MIT) core**, not a source-available
upsell a competitor can't touch for two years. (Their *self-hosting* is genuinely
good and worth copying — it is **not** the anti-lesson; the license carve-out on the
valuable layer is.)

**Diligence (updated 2026-07-18, post-verification):** full-stack self-hosting of the
Den control plane is **CONFIRMED** (repo docs + live GHCR Helm chart + no-egress
config) — don't repeat the "SaaS-only" claim. Still **unverified**: whether OpenWork
has *any* signed/pinned distribution or tamper-evident audit (we infer absence from
public docs — confirm against the `/ee` tree before any outward claim), and whether
the hosted-Cloud MCP path ever sees raw BYO keys (BYO-key ≠ no-passthrough).

### References (OpenWork)

- GitHub — https://github.com/different-ai/openwork
- Product site — https://openworklabs.com
- Remote MCP — `https://api.openworklabs.com/mcp/agent`
- Launch post — https://www.linkedin.com/posts/hiltch_today-we-are-launching-openwork-an-open-source-activity-7417259068232392704-HZXf

## 15. Related work: CodeNomad — a desktop-cockpit reference (2026-07-17)

[CodeNomad](https://github.com/NeuralNomadsAI/CodeNomad) (Neural Nomads AI, MIT,
**Electron + Tauri** builds, **SolidJS** frontend, Node 18+) is "**the command
center that puts AI coding on steroids**" — its own tagline is sharper: "**OpenCode
gives you the engine. CodeNomad gives you the cockpit.**" It is a cross-platform
desktop workspace that **wraps the OpenCode CLI** (a required dependency) and turns
it into a **multi-instance** command center: several OpenCode instances side by
side, **per-instance tabs**, deep **sub-session/task awareness**, **git worktree**
support, a **keyboard-first UI with a global command palette**, voice input,
**SideCars** (embed local web tools — VSCode via OpenVSCode Server, a `ttyd`
terminal — as tabs), file browser, theming, i18n. It ships as a desktop app
(mac/win/linux) **and a server mode** accessible from a browser for remote
development (password-gated on first launch, env/`auth.json` config, **self-signed
HTTPS** by default). MCP/skills aren't called out in its docs — because the **engine
(OpenCode) provides them**; CodeNomad is the cockpit over that engine.

**Category note (like §12 Odysseus, not §14 OpenWork).** CodeNomad is **not** the
same product category we are — it is a **single-user desktop cockpit for a coding
CLI**, with (per its docs) **no org/governance layer**: no policy-at-the-tool-seam,
no external-call audit, no signed/pinned definition distribution, no credential
broker, no RBAC/teams. It is best read as **(a)** a **UX reference for our desktop
surface** and **(b)** an example of a harness *shape a company could build on
OpenHarness* — not a competitor to the governed substrate. The convergence that
matters: **a Tauri desktop app built as a cockpit over a minimal TS coding engine
(OpenCode ↔ our Pi fork)** — the same skeleton as `apps/desktop`.

**What to borrow (desktop UX — the strongest ideas):**
- **Multi-instance / parallel sessions** with per-instance tabs and sub-session/task
  awareness — the pattern to study if our desktop grows past single-chat.
- **Git-worktree integration in the GUI** — surfaces isolated workspaces the way our
  `using-git-worktrees` flow does at the CLI.
- **SideCars** — embedding VSCode/`ttyd` as first-class tabs is a clean way to
  compose tools into the workspace without bloating the core.
- **Command palette + keyboard-first polish** — cheap, high-signal desktop quality.

**Anti-lesson (what NOT to copy) — the remote-access security model.** CodeNomad's
server mode exposes the workspace over a browser with **a password + self-signed
HTTPS**. That is precisely the ungoverned remote surface our **gateway hardening**
exists to replace: DPoP-authenticated, request-bound, no token passthrough, pinned
server pubkey, TLS-off-loopback required, authoritative audit. If we ever add a
browser/remote surface to our desktop, it must inherit the gateway's trust model,
**not** password + self-signed TLS.

**Diligence:** "no MCP/skills/governance" is inferred from CodeNomad's own docs; it
**inherits** OpenCode's MCP/skills through the engine, so don't claim it "can't do
MCP." Verify the engine boundary before any outward comparison.

### References (CodeNomad)

- GitHub — https://github.com/NeuralNomadsAI/CodeNomad
- Directory listing — https://yetanotherorchestrator.app/apps/codenomad/
