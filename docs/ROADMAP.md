# OpenHarness — Roadmap

Where the project is, where it's going, and *why* in that order. This is a
direction document, not a promise of dates. The [vision](vision.md) holds the
decisions (D1–D12); this holds the sequence.

## The through-line

Governance that a determined insider can't route around, without taking
execution away from the machine that does the work. v1 makes tampering
**evident** (signed definitions + hash-chained audit); the arc of the roadmap
is to make bypass **pointless** (org secrets and enforcement that never live on
the employee's laptop at all) — while keeping the whole stack self-hostable and
open source. We move a capability from "local-first" to "central" only when the
central version is a strict security gain, never to add a rent.

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

- A third example harness aimed at a **non-technical operator** (no `bash`,
  ask-on-every-write, heavy redaction) — proves the desktop ask-flow and the
  "everyone else" frontend on a realistic policy, and widens the demo's range.
- First-run desktop onboarding: pick a harness, drop in a key, first turn —
  without touching a terminal.
- `openharness doctor`: preflight a definition (unresolved prompt/skill/mcp
  refs, out-of-dir paths, a policy that would deny its own mandatory tools)
  before build.

## v2 — the remote MCP gateway (the moat)

The point where "evident" becomes "pointless." Today MCP-server secrets resolve
from the employee's local store; a determined insider can read them. v2 moves
the credential and the network egress **server-side**: the harness calls the
org gateway, the gateway holds the real credentials and talks to the third
party, and the employee's machine never sees the secret.

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

Boundary work lands with it, per the wiring checklist in `VAMMO.md`: transport,
storage bind, endpoint auth, which credentials it carries, and who can reach it.

## v2.x — trust the artifact end to end

- **OS code-signing + notarization** and a signed Tauri updater, so the three
  trust artifacts (our definition signature, the updater signature, the OS
  signature) are all real. Until then the built app is "signed definition inside
  an unsigned installer."
- **MCP supply-chain governance.** The Postmark-MCP incident (a trusted server
  update that silently BCC'd every sent email) and the wave of path-traversal /
  argument-injection CVEs in copied reference servers make this concrete: pin
  MCP servers by digest, optionally require server attestation, and make the
  policy layer first-class over `mcp__*` egress.

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
