# Contributing to OpenHarness

Thanks for wanting to build the harness with us. OpenHarness lets a company define
its **own** governed AI harness once and ship it to its people as a TUI and a
desktop app — signed, self-hosted, MIT. This guide gets you productive fast.

## Prerequisites

- **Node ≥ 22.19** (matches Pi's `engines`). We use **npm workspaces** (not pnpm/bun).
- **Rust** (stable) — only needed to build/check the desktop shell (`apps/desktop/src-tauri`)
  and to run `npx tauri build`. See the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Quick start

```bash
npm install
npm test            # vitest — the whole suite
npm run typecheck   # tsc (base + desktop UI)
# desktop shell compiles:
( cd apps/desktop/src-tauri && cargo check )
```

Try the product in 60 seconds — see [`docs/DEMO.md`](docs/DEMO.md).

## Repo layout

```
packages/
  definition   HarnessDefinition (harness.json + policy.json + mcp), zod-validated
  credentials  encrypted secret store + multi-account rotation + AuthProvider registry
  core         Pi session wiring, verified-load, loadAccounts, the CLI, policy extension
  mcp          MCP client + Pi tool bridge (mcp__server__tool)
  policy       deny-by-default rules + secret redaction (enforced via Pi hooks)
  audit        hash-chained JSONL audit log
  bundle       ed25519-signed definition bundles + verify
  server       thin bundle host + audit sink
  build        `openharness build` — a definition → a branded, signed desktop app
apps/
  tui          branded terminal entry (Pi InteractiveMode)
  desktop      Tauri v2 shell + React chat + Node WS sidecar
harnesses/     example definitions (example, acme-fintech, northwind-ops)
docs/          vision, specs, DEMO
```

`docs/vision.md` is the single source of truth for *why* things are shaped the way
they are (design decisions D1…). Read it before large changes.

## How we work

- **TDD.** Tests are co-located as `*.test.ts` next to the code. Write the failing
  test first; keep the suite green.
- **Integration over mocks** where a real object tests real behavior — especially for
  the policy/audit/bundle security invariants.
- **Conventional commits**: `feat(scope):`, `fix(scope):`, `docs(scope):`,
  `test(scope):`, `chore(scope):`, `harden(scope):`. One logical change per commit.
- **Branch, then PR.** Never push straight to `main`. Every change lands green
  (`npm test` + `npm run typecheck`, plus `cargo check` if you touched the shell).
- **Security-first review.** Changes to `policy`, `audit`, `bundle`, or `mcp` get an
  adversarial read: can a tool call slip enforcement? can a secret reach the log or the
  shipped bundle? does a check fail *closed*?

## Security invariants (don't regress these)

- A secret (API key, DB password, org private key) must **never** land in a committed
  file, a signed `.ohbundle`, or the audit log. Reference secrets by name; resolve at
  runtime from the local store.
- Policy is **deny/ask-by-default** where the author says so, and enforcement is
  in-process (can't be prompt-jailbroken). Ambiguous config fails **loud**, not open.
- The desktop app **boots pinned to a signed definition** and refuses tampered/rolled-back
  config. `openharness build` must never bake the org private key (there's a test that greps).

Found a vulnerability? Please open a private security advisory rather than a public issue.

## Adding a capability

1. Branch. 2. Write the failing test. 3. Implement minimally. 4. `npm test` + `npm run typecheck`
green. 5. Update `docs/` if you changed behavior or a decision. 6. Open a PR describing the
*why*.

Local planning docs under `docs/superpowers/` are gitignored — keep specs/plans there while
iterating; only durable design (`docs/vision.md`, `docs/specs/`) is committed.
