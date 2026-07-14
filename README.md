# OpenHarness

**Build your own AI harness. Own it end to end.**

[![CI](https://github.com/guim4dev/openharness/actions/workflows/ci.yml/badge.svg)](https://github.com/guim4dev/openharness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.19-3c873a.svg)

> A company's own governed AI harness — one definition, shipped as a TUI **and** a
> signed desktop app that refuses config it can't verify. Self-hosted, open source.
> **Landing:** [`site/index.html`](site/index.html) · **Try it:** [`docs/DEMO.md`](docs/DEMO.md)

OpenHarness is an open-source platform that lets a company define its own custom
AI agent harness — the prompts, skills, tools (MCP), permission policies,
credentials, and branding — once, and ship it to its people as **both a terminal
(TUI) and a downloadable desktop app**, from the same definition.

It is built as a surgical fork of [`earendil-works/pi`](https://pi.dev) (MIT), a
minimal TypeScript agent harness, and adds the layer Pi intentionally leaves out:
**governance without losing control** — self-hosted, local-first, provider-agnostic.

> Status: the walking skeleton runs (chat with a harness today with your own API
> key — see below), the governance data plane is built (MCP bridge, deny-by-default
> policy + secret redaction, hash-chained audit, ed25519-signed definition bundles,
> a thin bundle/audit server), and `openharness build` produces a branded, signed,
> ready-to-package desktop app. See [`docs/DEMO.md`](docs/DEMO.md) for the 90-second
> story, [`docs/vision.md`](docs/vision.md) for the full thinking, and
> [`docs/specs/`](docs/specs) for per-slice designs.

## Try it in 60 seconds

Bring your own key and have one live turn with the bundled example harness. No
account setup, no build step — just `npm install` and an API key in your env.

```bash
npm install

# Bring your own key (any one of these; the harness picks the matching provider):
export ANTHROPIC_API_KEY=sk-...
# or OPENAI_API_KEY=... / GEMINI_API_KEY=... / OPENCODE_GO_API_KEY=...

# One live turn against the example harness — streams the reply to your terminal:
npm run chat -- harnesses/example "Say hello in one line."
```

Want your own harness instead of the bundled example? `openharness init my-harness`
scaffolds a minimal, valid, offline-safe one to start from (see
[`docs/AUTHORING.md`](docs/AUTHORING.md)).

Your key is written to an encrypted on-disk store (never logged, never printed).
Prefer a config file over env vars? Create `accounts.json` in your OpenHarness
config dir (`~/Library/Application Support/openharness` on macOS,
`~/.config/openharness` on Linux) — `npm run chat` tells you the exact path if no
key is found:

```json
{
  "profiles": {
    "work": {
      "policy": "failover",
      "accounts": [
        { "id": "my-anthropic", "provider": "anthropic", "authProviderId": "api-key", "label": "personal", "apiKeyEnv": "ANTHROPIC_API_KEY" }
      ]
    }
  }
}
```

### The GUI

The same harness, same bring-your-own-key credentials, in a desktop window
(requires the [Tauri prerequisites](https://tauri.app/start/prerequisites/) —
Rust toolchain):

```bash
npm run dev:desktop
```

## Build a branded app

Turn a harness definition into a company-branded, signed desktop app — the app
boots pinned to the signed definition and refuses to run a tampered one:

```bash
npm run chat -- keygen --out org                        # the org's signing key (once)
npm run chat -- build harnesses/example --key org.key --out dist/acme --org acme --name assistant
cd dist/acme && npx tauri build                         # -> a branded installer
```

The full, runnable story (including the flip-one-byte-→-refusal beat) is in
[`docs/DEMO.md`](docs/DEMO.md).

## Why

Teams increasingly run agentic work across scattered tools with no shared
standard: everyone bring-your-own prompts, keys, and policies, and the company
has no view or control. OpenHarness centralizes the *definition* of how agents
work in an org — while keeping execution local and the whole stack open source
and self-hostable.

## The bet

LLMs are becoming a commodity. The durable value isn't the model — it's the
**harness**: the skills, tools, policies, memory, and the governance layer around
them. OpenHarness owns that layer and stays neutral on which model (or
subscription, or local runtime) sits underneath.

## Docs

| | |
|---|---|
| [`docs/DEMO.md`](docs/DEMO.md) | The 90-second story: build two brands → verify → flip one byte → refusal. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the pieces fit — the package map, the in-process governance data plane, the Pi seams. |
| [`docs/AUTHORING.md`](docs/AUTHORING.md) | Everything a `HarnessDefinition` directory can contain, and how to ship it. |
| [`docs/vision.md`](docs/vision.md) | The full thinking and the decision log (D1–D12) behind the shape. |
| [`docs/specs/`](docs/specs) | Per-slice designs (walking skeleton, governance data plane). |
| [`SECURITY.md`](SECURITY.md) | Threat model, fail-safe invariants, private reporting. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) | How to contribute · what has shipped. |

The eleven `@openharness/*` packages (plus `apps/tui` and `apps/desktop`) each
own one responsibility — the [architecture package map](docs/ARCHITECTURE.md#packages)
is the fastest way to find your way around the monorepo.

## Security

Found a vulnerability? See [`SECURITY.md`](SECURITY.md) for how to report it
privately, the fail-safe invariants the design is held to, and the honest
threat-model boundaries (local enforcement is debugger-bypassable; OS
code-signing isn't wired up yet).

## License

MIT (inherited from Pi). See `LICENSE`.
