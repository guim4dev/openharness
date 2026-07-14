# OpenHarness

**Build your own AI harness. Own it end to end.**

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

## License

MIT (inherited from Pi). See `LICENSE`.
