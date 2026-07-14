# @openharness/prompts

A tiny curated prompt library: loads a directory of `.md` prompts (YAML frontmatter `{ name, description }` + body) into a name-keyed map, and resolves a prompt by name.

Single responsibility, zero dependencies — its only I/O is reading the given directory. `@openharness/definition` uses it to resolve `lib:<name>` system-prompt references in a harness manifest.

## API

- `loadPromptLibrary(dir) -> Promise<PromptLibrary>` — parse every `.md` directly under `dir`; files with no `name` in frontmatter are skipped, and the first (sorted-order) file to declare a name wins on duplicates. Throws `PromptLibraryError` if the dir is missing.
- `resolvePrompt(lib, name) -> string` — return the prompt body; throws `PromptLibraryError` (listing available names) when the name is absent.
- `PromptLibraryError` — error thrown by both functions.
- Types: `PromptEntry` (`{ name, description, text }`), `PromptLibrary` (`Map<string, PromptEntry>`).

## Usage

```ts
import { loadPromptLibrary, resolvePrompt } from "@openharness/prompts";

const lib = await loadPromptLibrary("./prompts");
const text = resolvePrompt(lib, "support-agent");
console.log(text);
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.
