import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PromptEntry, PromptLibrary } from "./types.ts";

export class PromptLibraryError extends Error {}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a minimal YAML-ish frontmatter block: `---` fence, `key: value` scalar
 * lines (quotes optionally stripped), `---` fence, then the body. Not a general
 * YAML parser — prompt frontmatter is just { name, description }, so a full
 * YAML dependency isn't worth pulling in.
 */
function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { body: raw };
  const [, block, body] = match;
  const attrs: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) attrs[key] = value;
  }
  return { name: attrs.name, description: attrs.description, body };
}

/**
 * Load a PromptLibrary: every `.md` file directly under `dir`, each with YAML
 * frontmatter `{ name, description }`. Files with no `name` in frontmatter are
 * skipped. Files are processed in sorted-filename order and the FIRST file to
 * declare a given `name` wins — later duplicates are ignored.
 */
export async function loadPromptLibrary(dir: string): Promise<PromptLibrary> {
  const root = resolve(dir);
  let files: string[];
  try {
    files = await readdir(root);
  } catch (e) {
    throw new PromptLibraryError(`Prompt library directory not found: ${root} (${(e as Error).message})`);
  }

  const lib: PromptLibrary = new Map();
  for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
    const raw = await readFile(join(root, file), "utf8");
    const { name, description, body } = parseFrontmatter(raw);
    if (!name) continue; // no name in frontmatter -> not a curated prompt, skip
    if (lib.has(name)) continue; // dedup by name, first (sorted-order) wins
    const entry: PromptEntry = { name, description: description ?? "", text: body.trim() };
    lib.set(name, entry);
  }
  return lib;
}

/** Resolve `name` in `lib`, throwing a clear error listing available names when missing. */
export function resolvePrompt(lib: PromptLibrary, name: string): string {
  const entry = lib.get(name);
  if (!entry) {
    const available = [...lib.keys()].sort();
    const list = available.length > 0 ? available.join(", ") : "(none)";
    throw new PromptLibraryError(`Unknown prompt '${name}' in prompt library. Available prompts: ${list}`);
  }
  return entry.text;
}
