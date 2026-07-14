# Security Policy

OpenHarness centralizes how an org's AI agents access tools, credentials, and
data. Enforcement (policy, redaction, signing, audit) is exactly what makes the
product trustworthy — a security issue here is not "a bug," it's the product
failing at its one job. Reports are taken seriously and welcomed.

## Reporting a vulnerability

**Report privately — never in a public GitHub issue, discussion, or PR.** A
public report gives every user of a self-hosted product a live exploit before
a fix ships.

Use **[GitHub Security Advisories](https://github.com/guim4dev/openharness/security/advisories/new)**
for this repo (`guim4dev/openharness`) to open a private report. That's the
only channel monitored for security reports.

Include, if you can:
- The affected package/app (`packages/policy`, `packages/bundle`, `apps/desktop`, …) and version/commit.
- Repro steps or a minimal harness/policy that demonstrates the issue.
- What you'd expect the fail-safe behavior to be, and what actually happened.

**Do not include real secrets in the report** (API keys, tokens, credentials) —
describe their shape/prefix, never paste the literal value, even as "evidence."

This is a small, self-hosted, open-source project — there's no formal SLA, but
security reports get priority over everything else in the queue. A fix and an
advisory are the goal before any public disclosure.

## Supported versions

OpenHarness is pre-1.0 (`0.0.1`) and evolving quickly. Only **the latest commit
on `main`** is supported for security fixes — there's no LTS branch yet. If
you're running an older build (e.g. a previously-baked desktop app), update to
the current `main` and rebuild before reporting to confirm the issue still
reproduces.

## Fail-safe invariants

These are the guarantees the design is held to. If you find a case where one of
them breaks, that's a security bug regardless of how it's triggered:

- **Secrets never land in committed files, signed bundles, or the audit log.**
  Credentials live only in the local encrypted `SecretStore`
  (`@openharness/credentials`); `harness.json` / `policy.json` / MCP server
  config carry only credential *references* (profile names, `secrets:` env/header
  indirection), never literal values. The signed `.ohbundle` embeds the
  definition, never a key. The audit log (`@openharness/audit`) records only
  SHA-256 fingerprints of already-redacted payloads and non-sensitive metadata —
  never raw args, results, or prompt/message content.
- **Policy `deny` and `ask` fail closed, including on internal compute failure.**
  A tool call denied by policy is blocked before it runs. An `ask` with no human
  reachable (no client connected, timeout, disconnect, or the approval UI itself
  erroring) resolves to **deny**, never to allow. Redaction compute failing on
  pathological content (a circular reference, a non-serializable value) also
  fails closed: the tool call is blocked, or the tool result is withheld,
  rather than letting an unredacted fallback slip through.
- **Definitions are signed and anti-rollback protected.** `openharness bundle`
  ed25519-signs a definition; a verified boot (`@openharness/bundle`) refuses
  anything unsigned, tampered, or signed by the wrong key. An optional
  `minVersion` floor baked into a branded build refuses a validly-signed but
  *older* bundle, so a captured old build can't be replayed to roll back a
  security fix.
- **Credentials are provider-scoped.** Multi-account rotation/failover
  (`CredentialManager`) only ever selects an account whose `provider` matches
  the caller's — a harness talking to one vendor can never be handed another
  vendor's key, even under rotation.
- **Audit tamper-evidence is anchored server-side, not client-side.** The local
  hash chain is keyless and genesis-anchored — on its own it only catches
  accidental corruption or a naive in-place edit; a motivated writer with disk
  access can recompute the whole chain from the public genesis. Real
  tamper-**evidence** comes from `@openharness/server`, which retains a
  per-source HEAD and rejects any submission that doesn't continue it
  (re-chain from genesis, a fork, or a sequence gap is refused).

## Honest threat-model boundaries

Said up front rather than left for someone else to discover:

- **Local-first enforcement is bypassable by a determined user with a
  debugger.** Nothing running entirely on someone's own laptop can stop them
  from attaching a debugger to their own process. Signed builds make config
  tampering **evident** (a flipped byte fails verification), and the
  hash-chained + server-anchored audit trail makes a bypass **detectable**
  after the fact. The planned remote MCP gateway (credentials never touching
  the laptop) is what eventually makes bypass **pointless** rather than merely
  visible — that's not built yet.
- **OS code-signing isn't wired up yet, so the sidecar's own code integrity
  isn't sealed.** `@openharness/bundle` verifies the *definition* (prompts,
  skills, policy, MCP config) cryptographically before it's trusted. It does
  **not** yet verify that the desktop shell's own sidecar binary hasn't been
  swapped for a different one sitting next to it — that requires OS-level code
  signing/notarization, which is a tracked follow-up, not shipped. Don't rely
  on this build for defense against a compromised local install; it defends
  against a compromised or rolled-back *definition*.

## Scope

In scope: `packages/*`, `apps/*`, the CLI, and the signing/verification/audit
pipeline in this repo. Out of scope: vulnerabilities in upstream dependencies
(report those upstream — `earendil-works/pi`, the MCP SDK, etc. — unless the
issue is specifically in how OpenHarness uses them) and social-engineering
reports.
