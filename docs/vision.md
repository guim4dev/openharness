# OpenHarness — Vision & Knowledge Base

> Living document. Consolidates everything we know and every decision taken so
> far. Update it as decisions change; treat it as the single source of truth for
> *why* the project is shaped the way it is.

Last updated: 2026-07-13.

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
- **System-prompt control + a shared prompt library** the org curates.
- **Distribution / identity**: only approved builds run; SSO decides who uses
  which harness; centralized update/rollback of shipped TUI + desktop versions.
- **LLM gateway is optional.** Ideally users connect to a provider locally. A
  central gateway (keys, budgets, rate limits) can exist but is not the default —
  consistent with the commoditization bet.
- **Credentials ≠ API keys.** Users can register consumer subscriptions
  (ChatGPT/Claude Pro via OAuth), register **multiple accounts**, and the harness
  **rotates / fails over** across them as limits are hit.
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
- Consumer-subscription OAuth: legality/ToS considerations per provider.
