# OpenHarness — Vision & Knowledge Base

> Living document. Consolidates everything we know and every decision taken so
> far. Update it as decisions change; treat it as the single source of truth for
> *why* the project is shaped the way it is.

Last updated: 2026-07-14 (after an autonomous build night).

---

## 0. Current state (what's actually built)

On `main`, **245 tests green**, typecheck + `cargo check` green. A cross-cutting
integration test proves MCP + policy + audit compose end-to-end in one live
session, and an adversarial review pass hardened the security claims (honest
audit-integrity framing + server-side chain verification, policy fails loud on a
malformed rule, constant-time token). Packages/apps:

- **`@openharness/definition`** — HarnessDefinition (dir + `harness.json` + optional
  `policy.json` + `mcp` section), zod-validated, fail-fast loader. `systemPrompt`/
  `appendSystemPrompt` accept a plain file path (default) or a `lib:<name>` ref
  resolved against an optional `promptLibrary` dir — see `@openharness/prompts`.
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
(`meridian-support`, the non-technical desktop operator), and design specs for the two
next milestones (`docs/specs/`: the v1.1 desktop onboarding and the v2 remote MCP
gateway). **Deferred:** final `tauri build` + fresh-account validation (manual), OS
code-signing, remote MCP gateway + credential pooling, builder UI, cloud.

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
