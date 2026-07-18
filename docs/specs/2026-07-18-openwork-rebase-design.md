# OpenHarness on OpenWork — rebase spike (design proposal)

**Status:** PROPOSED — an isolated, discardable spike on a dedicated branch
(`openwork-rebase`). This is **not** a commitment to migrate. It is a bounded
experiment with explicit go/no-go criteria (§7); if any kill-switch trips, the
branch is discarded and we stay on the current Pi-based architecture. `dev`/`main`
are not touched until a human go decision.

**Relationship:** pairs with [`../vision.md`](../vision.md) §14 (OpenWork — our
closest analogue / north star) and the competitive map generated 2026-07-18. The
direction — a full rebase (Approach B) executed entirely on one branch — was chosen
by Guima over the incremental (A) and interop (C) alternatives.

**Provenance note:** the OpenWork facts below marked **[V]** were verified against
primary sources (repo + live Helm chart) by adversarial deep research (3-0 votes,
2026-07-18). Everything else is inferred from public docs / the current OpenHarness
tree and must be re-confirmed in the Phase-0 recon (§5) before it is trusted.

---

## 1. Goal, stated honestly

Rebase OpenHarness onto OpenWork's MIT surface: inherit its mature desktop app,
one-link setup, and opencode engine, and re-host our governance layer on top of it —
instead of building the product UX ourselves on the Pi fork.

The honest framing: **this adds no new security property.** Our differentiators
(signed/pinned definition, integrity-refusal, hash-chained audit, server-side PDP,
no-token-passthrough broker) already exist and are engine-agnostic. What the rebase
buys is **product surface and distribution UX we would otherwise hand-build** — at
the cost of taking on a large Electron/Swift monorepo, an engine swap (Pi→opencode),
and a downstream-of-a-fast-upstream maintenance burden. This spike exists to find out
whether that trade is worth it **before** betting the project on it. The branch is
the risk container.

## 2. Hard constraint — the FSL `/ee` boundary (non-negotiable)

OpenWork is dual-licensed **[V]**: everything outside `/ee` is MIT; the **entire**
`/ee` tree is **FSL-1.1-MIT** (Functional Source License) **[V]**. All of the Den
control plane lives under `/ee` **[V]**: `den-api`, `den-controller`, `den-web`,
`den-worker-proxy`, `den-worker-runtime`, `den-admin-mcp`, `den-db` (+ `inference`,
`landing`, `diagnostics`, `enterprise-mock-lab`).

FSL-1.1 forbids **Competing Use** **[V]** — making the software available in a
product/service that substitutes for it or offers substantially similar
functionality. **A rebase that carries `/ee` into OpenHarness and ships it as an OSS
alternative to OpenWork is the central prohibited case**, until each release
auto-converts to MIT (2nd anniversary) **[V]**. Internal self-hosted use is permitted
**[V]**, but that is not what a distributed product is.

**Therefore:** the fork derives from OpenWork's **MIT surface only**. The Den is
**not** forked; its *capability* is rebuilt as our own MIT control plane (Phase 4),
spec'd from the Den feature list — features are not copyrightable, code is.

**Enforcement (mechanical, not trusted to memory):** a CI guard fails the build if
any file whose provenance is the `/ee` tree enters the branch — same posture as the
existing build-time key-scan that proves no private key is baked into artifacts. A
`NOTICE` carries OpenWork's MIT attribution.

## 3. Current state — why this is additive, not a rewrite

- The "Pi fork" is, in practice, a **pinned npm dependency**
  (`@earendil-works/pi-coding-agent@0.80.6`, `pi-ai@0.80.6`) — not vendored source.
- **10 of 11 `@openharness/*` packages import Pi zero times**: `policy`, `audit`,
  `bundle`, `gateway`, `credentials`, `definition`, `build`, `server`, `prompts`,
  `sanity`. The entire governance layer — the value — is already engine-agnostic.
- Pi coupling is **13 import sites in 3 places**: `core` (5), `mcp` (2),
  `apps/tui` (2). The engine swap is contained to these.

So the rebase ports a largely engine-agnostic governance layer onto a new shell +
engine, rather than rewriting it.

## 4. Topology & branch (approved)

Single branch `openwork-rebase` in this repo. Layout = three layers:

1. **OpenWork-derived base (MIT):** desktop app + one-link + opencode integration,
   brought in via `git subtree` / `git read-tree` from `different-ai/openwork`
   **excluding `/ee`**. Pinned to a specific upstream commit (recorded), never
   `@latest`.
2. **Our governance (MIT, mostly intact):** the 11 `@openharness/*` packages ported
   in; the 10 engine-agnostic ones move almost unchanged.
3. **New MIT control plane:** rebuilt from the Den feature checklist (Phase 4).

Cross-cutting: the **anti-`/ee` CI guard** (§2) and a recorded upstream-sync commit
pointer.

## 5. Phases within the branch (decomposed — B is too large for one plan)

All phases live on the same branch; each is independently reviewable.

0. **`openwork-recon`** — the first concrete step and the primary viability probe.
   Map the real MIT tree: where the desktop app lives, the opencode integration
   points, what is reusable vs. what we replace, and the exact `/ee` boundary at the
   pinned commit. Deliverable: `docs/superpowers/plans/openwork-recon.md` (local,
   gitignored), analogous to the existing `pi-recon.md`.
1. **Skeleton** — branch + import the MIT subtree + green build + the anti-`/ee`
   guard wired into CI.
2. **Engine (opencode)** — introduce a thin `AgentEngine` interface at the 13
   coupling sites; opencode as the runtime; Pi adapter kept until parity is proven.
3. **Governance re-hosting** — engage policy / audit / bundle / gateway / credentials
   at opencode's tool seam. This is the crux (§6).
4. **MIT control plane** — last, optional; org/teams/RBAC/provisioning/version-control
   from the Den feature spec.

## 6. The critical unknown — opencode's tool seam

Our policy engine enforces **in-process, fail-closed, at the tool-call / tool-result /
before-provider-request seam**. The rebase only preserves our security posture if
**opencode exposes an equivalent seam** where a denied tool call is blocked before it
runs and where results/redaction are interceptable — and where a throw is treated as
*deny*, not *allow*. Phase-0 recon must answer this concretely (interface + code
path), because it is the difference between "governed harness on opencode" and "a nice
desktop app with advisory policy." If the seam is advisory-only, that is a go/no-go
trigger (§7).

## 7. Go / no-go criteria (kill-switches, evaluated before any merge)

Abort the branch (and stay on the Pi architecture) if any hold:

- **No enforcement seam:** opencode has no tool seam where policy engages fail-closed
  (governance becomes advisory) — see §6.
- **`/ee` runtime dependency:** the MIT desktop app requires `/ee` code at runtime, so
  "MIT shell" is not self-sufficient without touching FSL code.
- **Sync infeasible:** staying downstream of a ~3.7k-commit, fast-moving upstream is
  unsustainable for our team size.
- **Swap cost blows scope:** the opencode swap turns out to touch far more than the 13
  sites (e.g. deep provider/session assumptions).

## 8. What we are explicitly NOT doing

- Not forking, vendoring, or shipping any `/ee` (Den) code.
- Not touching `dev`/`main` until a human go decision on the branch.
- Not abandoning the Pi-based build — it remains the shipping architecture until (and
  unless) the spike clears every §7 gate.
- Not building the control plane (Phase 4) before the engine + governance (Phases
  2–3) are proven on the branch.

## 9. Open questions — resolve in Phase-0 recon

- Exact MIT-vs-`/ee` split of the desktop app and the opencode bridge (is the app
  fully MIT, or does it reach into `/ee`?). *[inferred MIT — must confirm]*
- opencode's tool-seam shape (§6) and whether fail-closed interception is possible.
- Whether the one-link setup logic is MIT or `/ee`.
- Build/packaging stack of the MIT app (Electron? native? Swift components?) and how
  it coexists with our TS-pure monorepo + Tauri desktop.
- Upstream-sync strategy: subtree pull cadence, our patch surface, divergence budget.
