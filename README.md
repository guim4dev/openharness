# OpenHarness

**Build your own AI harness. Own it end to end.**

OpenHarness is an open-source platform that lets a company define its own custom
AI agent harness — the prompts, skills, tools (MCP), permission policies,
credentials, and branding — once, and ship it to its people as **both a terminal
(TUI) and a downloadable desktop app**, from the same definition.

It is built as a surgical fork of [`earendil-works/pi`](https://pi.dev) (MIT), a
minimal TypeScript agent harness, and adds the layer Pi intentionally leaves out:
**governance without losing control** — self-hosted, local-first, provider-agnostic.

> Status: early design. See [`docs/vision.md`](docs/vision.md) for the full
> thinking and [`docs/specs/`](docs/specs) for per-slice designs. Nothing is
> built yet.

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
