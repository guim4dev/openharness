# v2 — Remote MCP Gateway (design proposal)

**Status:** DRAFT proposal for review. Not approved for implementation. Written
autonomously and pressure-tested with a design advisor (Fable); the open
questions in §8 must be answered by a human before any implementation plan.

**Relationship to the roadmap:** this is the concrete design behind the v2
milestone in [`../ROADMAP.md`](../ROADMAP.md). Read the v1 governance model in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) first.

---

## 1. Goal, stated honestly

In v1, an MCP server's real credential (a DB password, an API token) resolves at
connect from the **machine-local** secret store — so today the org's secret lives
on the employee's laptop, and local enforcement is bypassable with a debugger.
v1 makes tampering *evident* (signed definitions + hash-chained audit); it does
not make credential theft *impossible*.

v2 moves the credential and the network egress **server-side**: the employee's
harness calls an org **gateway**; the gateway holds the upstream credentials and
talks to the third-party MCP servers / APIs; the employee's machine never sees
the secret. Server-side policy and audit become authoritative — a patched local
binary cannot skip them.

**What v2 actually buys — and what it does not.** The honest claim is *not*
"bypass becomes pointless." A patched local binary still holds a valid gateway
session for its user and can drive every tool that user's policy allows —
maliciously, at machine speed. v2 converts:

> "compromised employee machine → stolen org credentials, used invisibly, forever"

into

> "compromised employee machine → abuse confined to that user's policy scope,
> fully audited server-side, revocable in one place."

That is a real, marketable moat. It must be stated with the same candor as v1's
boundary, because a buyer's security team finds the gap in one whiteboard session
otherwise. Two scoping truths that travel with it:

- **The gateway is authoritative only for the egress it mediates.** Local tools
  (`bash`, file edits, and the LLM API call itself) stay under v1's bypassable
  local enforcement. Which tools are *gateway-governed* vs *locally-governed*
  must be **visible in the definition schema**, not implicit.
- **"The machine never sees the secret" is scoped to gateway-only deployments.**
  Personal consumer seats (ChatGPT/Codex/OpenCode-Go) stay local by decision
  (D11), and any offline fallback that keeps local org secrets working falsifies
  the claim (see §3.4). Scope the sentence; don't overclaim it.

## 2. Architecture

The gateway **is itself an MCP server** to the harness (Streamable HTTP). This
keeps the harness change tiny: one more MCP entry (with auth), and every gateway
tool is still named `mcp__<server>__<tool>`, so v1 policy syntax carries over
unchanged.

Components:

1. **AuthN terminator** — validates gateway-issued, sender-constrained tokens (§3).
2. **Pinned virtual tool catalog** — the client's `tools/list` is served from the
   gateway's *pinned* catalog (tool schemas + descriptions hashed into the signed
   definition), **never proxied live** from upstreams. This one decision kills
   rug-pull tool poisoning at the client: a malicious upstream update can't change
   what the client sees a tool does.
3. **PDP (policy decision point)** — the **same `@openharness/policy` package**,
   version-pinned identically in client and gateway, evaluating the **same signed
   policy**. Two engines that merely "implement the same semantics" drift on glob
   edge cases and first-match ordering; one shared package, with the policy
   version recorded in every audit entry, does not.
4. **Credential broker** — KMS/HSM-backed, per-upstream isolation (separate keys,
   ideally separate processes); mints short-lived scoped credentials; plaintext
   exists only inside the connector process, never in a structure that serializes
   toward the client. Resolved **after** the allow decision, never before.
5. **Connector runtime** — per-upstream sandboxed connector processes, each with
   its own egress allowlist and a **forward-proxy tap** on outbound requests (§5).
6. **Redaction / DLP filter** — both directions.
7. **Audit writer** — the server-side hash chain is now authoritative. Keep the
   v1 local chain too and **cross-check the two**: divergence is itself tamper
   evidence, turning dual chains from redundancy into a detection feature.

**Request flow (one governed MCP tool call):**

```
harness tools/call
  → authN: who (employee) + which harness + which definition version
  → PDP evaluates  ← AUTHORITATIVE HERE (last org-controlled point before
                     credential use and egress; anything client-side is
                     advisory UX only)
      allow → argument sanitation against the PINNED schema + SSRF/destination
              checks on any URL-bearing arg
            → credential broker resolves the upstream cred (post-decision)
            → connector calls upstream THROUGH the egress proxy
            → response: size caps, redaction, injection-content flagging
            → audit append (identity, policy version, decision, arg+result hashes)
            → return to harness
      ask   → server-side pending-approval queue (§3, failure mode 2)
      deny  → blocked; reason returned
```

Redaction on the return path cleans tool results **before they enter the LLM
context** — so the gateway also protects the BYO-LLM egress path (via
pre-context redaction) without proxying the LLM.

**Deny upstream-initiated `sampling` and `elicitation` by default.** Upstream
sampling is a direct injection channel from a third-party server into the
employee's local model. v2 is request/response tools only.

## 3. AuthN / AuthZ and the failure modes it must survive

- **Employee → gateway:** OIDC auth-code + PKCE (device code for the TUI) against
  the org IdP, exchanged once at login for a **short-lived, sender-constrained**
  gateway token — DPoP-bound to a keypair in the OS keychain (reuse the v1 secret
  store). Claims: `sub`, IdP groups, harness id, definition version/hash, session
  id. DPoP kills token replay off the machine.
- **Harness identity is client-asserted.** A patched binary lies about its
  definition hash. Without hardware attestation (de-scoped, §7), harness identity
  is for **audit and policy routing, not a security boundary** — no policy rule's
  security may depend on "this came from an unmodified harness."
- **Per-user least privilege:** extend the policy schema with `principals` (IdP
  groups → rules) **and per-user rate / data-volume budgets** — least privilege
  without throughput limits still permits full-corpus exfiltration through allowed
  read tools.
- **Upstream auth without passthrough — defined precisely.** The ban is on
  *forwarding an inbound token to an upstream*. It does **not** ban the gateway
  custodying each user's own upstream grant (obtained by the user consenting once,
  server-side) and minting access tokens on its own authority. RFC 8693 token
  exchange is the clean form, but **almost no SaaS upstream supports 8693 in
  2026** — design for gateway-custodied per-user grants + org service credentials;
  treat 8693 as an optimization where available.

**The failure modes this design must survive** (ranked by how badly they bite):

1. **Prompt injection doesn't care where the credential lives.** A poisoned
   document makes the agent issue a *policy-allowed* call — `send_email` to an
   attacker, a CRM export, a Jira comment carrying secrets. The gateway
   authenticates the user, checks policy, and executes the exfiltration with its
   own credential, beautifully audited. **This is exactly where v2 degrades to a
   naive proxy: if policy is tool-name-granular rather than argument-granular,
   you moved the credential and changed nothing about the dominant 2026 attack.**
   → Argument-level rules (recipient/destination allowlists on send-class tools),
   "new destination requires ask," egress DLP, volume/novelty anomaly detection.
   *Argument-level policy is the line between a governance layer and a
   privilege-escalation appliance.*
2. **Server-side `ask` is an undesigned distributed-systems problem.** v1's ask is
   a synchronous local prompt. At the gateway: who approves, over what channel,
   with what rendering? If the approval UI is rendered by the (possibly
   compromised) harness, the harness lies about what's being approved; and
   self-approval is theater when the threat model is "the user's own agent is
   compromised." Needs: an **out-of-band authenticated surface** (web/Slack push)
   that renders args **server-side**, fail-closed timeouts, idempotency (agents
   retry), and an approval-fatigue story. Budget it as its own workstream.
3. **Blast-radius inversion.** Today one compromised laptop leaks one employee's
   credentials. v2 concentrates **every** org credential in one self-hosted,
   open-source service — often run by companies without a security team. One
   SSRF/deserialization bug in the gateway outranks every risk it removes.
   → Per-upstream credential and process isolation; short-lived creds everywhere
   (a memory dump ages out in minutes); no plaintext at rest; minimal surface (no
   admin UI in-process); a hardening guide treated as a shipped product artifact.
   Decide the availability story: gateway down = all agents blind.
4. **The offline/fallback path silently un-ships v2.** If "offline mode" keeps
   local org credentials working, the flagship claim is false the day a fallback
   is provisioned — and fallbacks become the norm. Either v2 *removes* local
   org-service secrets (offline = those tools unavailable) or the moat is
   documented as covering gateway-only deployments. Decide in §8.
5. **MCP session multiplexing leaks state across users.** Naively pooling one
   upstream connection cross-contaminates: notifications to the wrong user,
   server-side session state keyed to the pooled identity, a Postgres connector
   where one user's `SET ROLE`/temp tables bleed into another's calls. Per-user
   upstream sessions (or strict session mapping) **from day one** — retrofitting
   is miserable.

## 4. Supply chain (Postmark-class defense)

Decompose by where the third-party code runs:

- **Self-run MCP servers (npm packages the org executes):** run in the connector
  sandbox — pinned version + lockfile hash (sigstore attestation where available),
  container digest, read-only FS, no ambient creds, egress allowlist to exactly
  the upstream API host. **No auto-update, ever:** a version bump is a definition
  change → re-sign → a human reviews the **tool-catalog diff and dependency
  diff** (tool-description diffs are where poisoning hides; render them in review).
- **The Postmark lesson pins deeper than egress allowlisting.** The malicious BCC
  rode the *legitimate* API call — egress allowlist and gateway arg inspection
  both miss it, because the MCP server adds the BCC *after* the gateway hands it
  clean args. Two real defenses: **(a)** the forward-proxy tap between connector
  and upstream API, inspecting actual outbound request bodies for high-risk verbs
  (a BCC the user never specified is visible and blockable there); **(b)** for the
  highest-risk verbs (email send, payments, file share), **skip the third-party
  MCP wrapper entirely** — the gateway calls the SaaS REST API through its own
  thin first-party adapter. MCP is the client-facing protocol; nothing forces the
  gateway to consume someone's npm package to POST to an API.
- **Remote hosted MCP servers:** you can't see behind their API. Pin domain +
  OAuth audience, classify what data classes may flow there, and treat it as an
  explicit vendor-trust entry in the definition. Don't pretend response inspection
  governs a remote server's behavior.
- **Rogue registration** is solved structurally: clients only ever see the
  gateway's virtual catalog; upstreams exist only if signed into the definition.
  The residual question is governance of the *signer* (§8, separation of duties).
- **Response hygiene:** size caps, MIME checks, flag/wrap instruction-like content
  in results (spotlighting). Heuristic — position as detection, not prevention.
- **SSRF:** per-tool destination allowlists on URL-bearing args; connectors
  resolve DNS via the proxy; private ranges blocked by default.

## 5. Smallest defensible v2 slice

OIDC login + DPoP-bound gateway tokens → pinned virtual catalog → the **same
signed policy** evaluated server-side with per-principal rules and per-user quotas
→ org service creds in KMS, resolved post-decision → request/response tool calls
through per-connector egress allowlists → redaction on the return path →
server-side hash-chained audit cross-checked against the local chain → `ask` =
fail-closed pending-approval queue with a minimal **server-rendered** web approval
page (agent polls; no local rendering of approval content).

That slice already delivers the headline — *secrets off the endpoint; policy and
audit a patched binary cannot skip* — for the connectors it ships.

## 6. Explicitly de-scoped from v2

Hardware/client attestation; RFC 8693 against upstreams; per-user upstream OAuth
brokering (→ v2.1); generic "bring any MCP server" hosting (→ v2.1 — ship 2–3
first-party connectors, e.g. GitHub + Postgres-read, first); MCP
sampling/elicitation/subscriptions (deny); ML-based response screening;
HA/multi-region; a policy-authoring UI; SIEM export; **any change to local-tool
governance**.

## 7. Boundary declaration (per the wiring checklist)

Before any "ready to use," the gateway must declare: transport (Streamable HTTP,
TLS, org-network or public-with-IdP), storage bind (KMS/HSM; no plaintext at
rest), endpoint auth (OIDC + DPoP-bound tokens; no anonymous path), credentials it
carries (org service creds + custodied per-user grants — the crown jewels), and
who reaches it (SSO'd employees only; the gateway URL + public key **pinned inside
the signed definition** so a hostile network can't present a fake gateway on first
boot).

## 8. Open questions a human must answer before implementation

1. **`ask` approver model:** may a user approve their own agent's actions? Which
   verbs demand a second person? (Decides whether `ask` is a control or a ritual.)
2. **Upstream attribution:** must actions appear as the *user* in GitHub/Jira
   (forces per-user grant custody → v2.1), or is service-account attribution +
   gateway audit acceptable for v2?
3. **Offline semantics:** gateway unreachable → hard fail, read-only local, or
   local-credential fallback? Does v2 adoption *delete* existing local org secrets
   or leave them dormant? (This decides whether the flagship claim is true.)
4. **Separation of duties:** can one definition-signer unilaterally add a new
   upstream (a new exfiltration destination), or is a two-signer rule required for
   registry changes?
5. **Audit content vs privacy:** full args in the authoritative log is a second
   crown jewel (business data, PII). Store redacted args, hashes-only, or
   full-with-access-control? (Order of redaction vs audit changes forensic value.)
6. **Break-glass:** during a gateway outage mid-incident, is there an emergency
   direct-credential path, who holds it, and how is its use made loud?
7. **Tenancy:** one gateway per org or per team?

---

*Constraint check (from the advisor):* "no token passthrough" is correct **if**
read as "never forward an inbound token" — it must not be read as banning
gateway-custodied per-user grants, which v2.1 needs. "No pooling of personal
seats" is correct but quietly falsifies "the machine never sees secrets" — scope
the claim (§1). BYO-LLM is fine, but the model provider is an egress path the
gateway governs **only** via pre-context redaction — say so before a customer's
DLP team does.
