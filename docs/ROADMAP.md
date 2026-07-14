# OpenHarness — Roadmap

Where the project is, where it's going, and *why* in that order. This is a
direction document, not a promise of dates. The [vision](vision.md) holds the
decisions (D1–D12); this holds the sequence.

## The through-line

Governance that a determined insider can't route around, without taking
execution away from the machine that does the work. v1 makes tampering
**evident** (signed definitions + hash-chained audit); the arc of the roadmap is
to move org secrets and egress governance off the employee's laptop entirely, so
that a compromised endpoint means *abuse confined to one user's policy scope,
fully audited and revocable in one place* — not stolen org credentials used
invisibly forever. (Not "bypass becomes pointless": a patched binary still holds
a valid session and can drive every tool its user's policy allows — the honest
win is confining and auditing the blast radius, not eliminating it.) All of this
stays self-hostable and open source. We move a capability from "local-first" to
"central" only when the central version is a strict security gain, never to add
a rent.

## Where we are — v1 (shipped)

A company defines its harness once and ships it, governed and signed, as a TUI
**and** a desktop app. Mapped to the 2026 enterprise-governance baseline that
buyers are now held to (SOC 2, ISO/IEC 42001, NIST AI RMF, and the EU AI Act's
high-risk obligations landing **2 Aug 2026**):

| Governance requirement (industry baseline) | OpenHarness v1 |
|---|---|
| Policy as **machine-readable code**, not prose | `policy.json` — deny-by-default, first-match, model allow/deny, arg-matching; enforced in-process at Pi's hooks |
| **Human approval** node for high-impact actions | policy `ask` — branded approve/deny in TUI + desktop, fail-closed |
| **Immutable audit** of agent actions | hash-chained JSONL (external calls only); server retains the authoritative, continuity-checked record |
| Secrets in a **store, not plaintext**; deny credential paths | encrypted secret store; MCP secrets by *reference*; the `api-key:*` LLM-credential namespace is rejected as an MCP ref |
| **Least privilege / isolation** per agent | provider-scoped credential selection; per-app identifier isolation of creds/audit/state |
| **Supply-chain integrity** of what runs | ed25519-signed `.ohbundle`; the app boots pinned to a verified definition and refuses tamper/rollback |

The honest gap v1 leaves open, stated plainly in [`SECURITY.md`](../SECURITY.md):
local enforcement is bypassable by an employee with a debugger, and OS
code-signing is not yet wired. The next milestones close exactly those.

## v1.1 — the non-technical desktop path, hardened

v1's design target is technical employees (D12), but the desktop GUI exists for
everyone else. Before we lean on that claim we should exercise it.

- **✓ Shipped** — a third example harness aimed at a **non-technical operator**
  (`bash` denied, ask-on-every-write, heavy redaction): `harnesses/meridian-support`,
  which proves the desktop ask-flow and the "everyone else" frontend on a
  realistic policy and widens the demo's range.
- **✓ Shipped** — `openharness doctor`: preflight a definition without building
  it. On top of the loader's structural/reference checks it flags the
  self-consistency traps the loader doesn't — a model the harness's own policy
  denies, a missing branding icon, an MCP secret in the reserved `api-key:*`
  namespace, a default-deny with no allow rule, and a mandatory MCP server whose
  every tool is denied.
- **✓ Shipped** — first-run desktop onboarding: when no credential resolves, the
  sidecar emits a recoverable `needs_setup` and the app shows a paste-a-key panel
  (written to the machine-local encrypted store over the loopback sidecar, never
  leaving the machine); `set_credential` → `ready` enables chat with no restart.
  Fail-closed on a blank key. The key **survives a restart** — the secret stays
  in the encrypted store and a keyless `accounts.json` reference is persisted,
  resolved by `loadAccounts` next launch. (Provider OAuth subscriptions remain a
  follow-up.)

## v2 — the remote MCP gateway (the moat)

Where credential theft stops paying off. Today MCP-server secrets resolve from
the employee's local store; a determined insider can read them. v2 moves the
credential and the network egress **server-side**: the harness calls the org
gateway, the gateway holds the real credentials and talks to the third
party, and the employee's machine never sees the secret.

> **✓ Built, end to end** (`@openharness/gateway` + core bridge) — the governed
> pipeline as an MCP server: pinned virtual catalog · DPoP-bound tokens · the
> shared policy engine server-side (per-principal, argument-level) · a
> KMS-interface credential broker resolved *after* the decision · a sandboxed
> connector runtime (egress allowlist + forward-proxy tap + one first-party
> GitHub-read connector) · return-path redaction · authoritative hash-chained
> audit · fail-closed server-side approval · per-user session isolation. The
> **transport** closes the loop: a definition declares a `gateway` (url + pinned
> pubkey + tools); a deployable HTTP entry (`startGatewayHttp`) authenticates
> every request at the edge with DPoP (token + request-bound proof + key-binding,
> no passthrough, no session affinity); core bridges the pinned tools into the
> live session as `mcp__<gateway>__<tool>`, fail-closed at boot when the declared
> gateway is unreachable. Proven over real loopback HTTP end to end, and
> **runnable** — `openharness-gateway serve <config.json>` boots the pipeline from
> a zod-validated config against a machine-local encrypted secret store.
> **Remaining:** deploy hardening — a real IdP/token-exchange flow, a KMS-backed
> broker, a containerized connector sandbox. The connector/broker layer is behind swappable
> interfaces so [OpenConnector](vision.md#13) can slot in as the backend once it
> matures.

This is also where the ecosystem's sharpest edges live, so the design is
constrained by them rather than discovering them later:

- **No token passthrough.** The gateway is *not* a proxy that forwards a token
  it was handed — that pattern (flagged across 2026 MCP threat models, and the
  root of the "confused deputy" and exfiltration-proxy vectors) breaks every
  audit trail and rate limit. The gateway holds its own scoped credential per
  upstream and mints/exchanges on its own authority (OAuth 2.1 token exchange).
- **Server-side policy + audit is authoritative.** Enforcement and the
  hash-chained record move behind the gateway, so a patched local binary can't
  skip them. The local extension stays as defense-in-depth and for offline use.
- **Governed credential pooling** — but only where it's *not* a consumer
  subscription (D11 stands: personal ChatGPT/Codex/OpenCode-Go seats are never
  pooled across users). Org service credentials rotate behind the gateway under
  least-privilege, scoped per upstream.
- **A compliance/export API** so the authoritative audit stream feeds existing
  SIEM / retention systems — the integration regulated buyers actually ask for.
  ✓ Built: `exportAuditLog` / `openharness audit export` emit filtered records
  plus an integrity manifest (chain verified + head hash), gating on integrity.

Boundary work lands with it: transport, storage bind, endpoint auth, which
credentials it carries, and who can reach it — with the gateway's URL and public
key pinned inside the signed definition. The full design (architecture, the
failure modes it must survive, the smallest defensible slice, and the open
questions a human must answer first) is in
[`specs/2026-07-14-remote-mcp-gateway-design.md`](specs/2026-07-14-remote-mcp-gateway-design.md).

## v2.x — trust the artifact end to end

- **OS code-signing + notarization** and a signed Tauri updater, so the three
  trust artifacts (our definition signature, the updater signature, the OS
  signature) are all real. Until then the built app is "signed definition inside
  an unsigned installer."
- **MCP supply-chain governance.** The Postmark-MCP incident (a trusted server
  update that silently BCC'd every sent email) and the wave of path-traversal /
  argument-injection CVEs in copied reference servers make this concrete: pin
  MCP servers by digest, optionally require server attestation, and make the
  policy layer first-class over `mcp__*` egress. ✓ Started: `doctor` flags any
  MCP server fetched unpinned on launch across npm/PyPI/container runners
  (containers pinned only by an `@sha256:` digest), and `--strict-supply-chain`
  turns that into a build-failing gate. Remaining: server attestation, and
  policy-layer defaults over `mcp__*` egress.

## v3 — reach

- **Visual harness builder** — author `harness.json` + `policy.json` without
  hand-editing JSON, so a non-engineer owner can shape and ship a harness.
- **Managed cloud** — a hosted gateway + bundle host + audit sink for orgs that
  don't want to run infra, with the self-hosted path always a first-class equal.

## Non-goals (still)

- We are the harness a company brands and ships — **not** a meta-layer over
  other harnesses (D9). No supporting multiple agent runtimes underneath.
- No pooling of personal consumer subscriptions across users (D11).
- No betting the product on owning the model. LLMs commoditize; the durable
  value is the harness and the governance around it (the bet).

## How to read the sequence

Each milestone is independently shippable and green on its own. v1.1 is polish
and proof; v2 is the security thesis paying off; v2.x makes the artifact
trustworthy end to end; v3 is reach. If you want to help, the v1.1 items are the
best on-ramp — see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

*Grounding:* the requirement mapping and the v2/v2.x threat constraints are
drawn from the 2026 enterprise AI-agent governance baseline and published MCP
threat models — notably the NSA/CISA Cybersecurity Information Sheet on MCP
security and the widely-reported Postmark-MCP supply-chain incident. This
document paraphrases that landscape; it does not reproduce any external text.
