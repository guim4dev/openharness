# @openharness/sanity

An internal smoke/sanity-check package — not a public API.

A trivial workspace package that confirms the monorepo's toolchain (npm
workspaces, TypeScript ESM, vitest) is wired up correctly. It exports a single
`ping()` and is exercised by one test; it is not meant to be consumed by other
packages.

## API

- `ping() -> "pong"` — returns the string `"pong"`.

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.
