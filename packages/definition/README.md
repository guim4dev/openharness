# @openharness/definition

The `HarnessDefinition` schema and loader — turns a harness directory (`harness.json` + system prompt + optional `policy.json`, skills, MCP, branding) into a validated, typed object.

Foundational package: everything downstream (`core`, `build`, `bundle`) consumes a loaded `HarnessDefinition`. It depends on `@openharness/policy` (to parse `policy.json`) and `@openharness/prompts` (to resolve `lib:` prompt refs), and on nothing frontend- or Pi-related.

## API

- `loadHarnessDefinition(rootDir) -> Promise<HarnessDefinition>` — read + validate a harness dir; resolves the system prompt (file path or `lib:<name>` ref), skills, icon, and optional `policy.json`. Throws `HarnessDefinitionError`.
- `scaffoldHarness(dir, opts?) -> Promise<ScaffoldHarnessResult>` — write a minimal, offline-safe starter harness into an empty/missing dir. Throws `ScaffoldError` on a non-empty dir.
- `harnessManifestSchema` — zod schema for `harness.json` (parses to `HarnessManifest`).
- Types: `HarnessDefinition`, `HarnessManifest`, `McpServerSpec`, `HarnessMcpConfig`, `HarnessProviderConfig`, `HarnessSkillRef`, `HarnessBranding`, `McpTransport`, `ScaffoldHarnessOptions`, and `Policy` (re-exported).

## Usage

```ts
import { loadHarnessDefinition, scaffoldHarness } from "@openharness/definition";

await scaffoldHarness("./acme", { name: "acme", provider: "anthropic" });

const def = await loadHarnessDefinition("./acme");
console.log(def.manifest.branding.displayName);
console.log(def.systemPromptText);
if (def.policy) console.log("default action:", def.policy.default);
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.
