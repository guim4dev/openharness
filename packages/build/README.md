# @openharness/build

`buildHarnessApp` — turns one `HarnessDefinition` into a branded, signed, ready-to-package Tauri project.

The `openharness build` engine: it signs the definition into a bundle (via `@openharness/bundle`), bakes `{bundle, org public key, min-version floor, single-file sidecar}` as sealed Tauri resources, and templates a per-brand `tauri.conf.json` (product name + reverse-DNS identifier). `apps/desktop` is never mutated and the private key is only ever read to sign — never copied into the artifact. Fails loud if the definition references any file outside its own dir (those would not be bundled).

## API

- `buildHarnessApp(opts) -> Promise<BuildHarnessAppResult>` — build the project from `BuildHarnessAppOptions` (`defDir`, `privateKeyPath`, `outDir`, optional `org`, `name`, `repoRoot`); resolves to `{ outDir, identifier, productName, bundle: { name, version }, resources }`.
- Types: `BuildHarnessAppOptions`, `BuildHarnessAppResult`.

## Usage

```ts
import { buildHarnessApp } from "@openharness/build";

const result = await buildHarnessApp({
  defDir: "./acme-harness",
  privateKeyPath: "./secrets/org-ed25519.pem",
  outDir: "./dist/acme-app",
  org: "acme",
});

console.log(result.identifier); // ai.openharness.acme.acme-harness
console.log(result.resources);  // ["harness.ohbundle", "org.pub", "min-version.txt", "server.mjs"]
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.
