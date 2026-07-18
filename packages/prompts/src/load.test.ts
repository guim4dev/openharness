import { afterAll, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPromptLibrary, resolvePrompt, PromptLibraryError } from "./load.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "..", "test-fixtures", name);

// Scratch base for tests that need to build a library dir on the fly (subdir
// entries, quoting edge cases). Static fixtures can't hold a directory named
// `*.md`, so those cases are constructed here.
const scratchBase = mkdtempSync(join(tmpdir(), "oh-prompts-test-"));
afterAll(() => rmSync(scratchBase, { recursive: true, force: true }));

test("loadPromptLibrary lists and loads curated prompts, skipping files with no name", async () => {
  const lib = await loadPromptLibrary(fixture("basic"));
  expect([...lib.keys()].sort()).toEqual(["alpha", "beta"]);

  const beta = lib.get("beta")!;
  expect(beta.name).toBe("beta");
  expect(beta.description).toBe("The beta prompt, quoted description.");
  expect(beta.text).toBe("Beta body text.\n\nMultiple lines survive.");
});

test("dedups by name — the first file in sorted order wins over a later duplicate", async () => {
  const lib = await loadPromptLibrary(fixture("basic"));
  const alpha = lib.get("alpha")!;
  expect(alpha.description).toBe("The first alpha prompt (sorts before the duplicate below).");
  expect(alpha.text).toBe("First alpha body.");
});

test("files without a `name` in frontmatter (or without frontmatter at all) never appear", async () => {
  const lib = await loadPromptLibrary(fixture("basic"));
  expect(lib.size).toBe(2);
  for (const entry of lib.values()) {
    expect(entry.text).not.toMatch(/must never surface|must be skipped/);
  }
});

test("resolvePrompt returns the text for a known name", async () => {
  const lib = await loadPromptLibrary(fixture("basic"));
  expect(resolvePrompt(lib, "alpha")).toBe("First alpha body.");
});

test("resolvePrompt throws a clear error listing available names when the name is unknown", async () => {
  const lib = await loadPromptLibrary(fixture("basic"));
  expect(() => resolvePrompt(lib, "nope")).toThrow(PromptLibraryError);
  expect(() => resolvePrompt(lib, "nope")).toThrow(/alpha.*beta|beta.*alpha/);
});

test("loadPromptLibrary throws a clear error for a nonexistent directory", async () => {
  await expect(loadPromptLibrary(fixture("does-not-exist"))).rejects.toThrow(PromptLibraryError);
});

test("one non-regular-file entry ending in .md does not abort the whole library", async () => {
  const dir = mkdtempSync(join(scratchBase, "subdir-md-"));
  writeFileSync(join(dir, "good.md"), "---\nname: good\n---\nGood body.\n");
  // A subdirectory whose name ends in `.md` — readFile on it would throw EISDIR.
  mkdirSync(join(dir, "bad.md"));

  const lib = await loadPromptLibrary(dir);
  expect([...lib.keys()]).toEqual(["good"]);
  expect(lib.get("good")!.text).toBe("Good body.");
});

test("quoted frontmatter values are trimmed after the quotes are stripped", async () => {
  const dir = mkdtempSync(join(scratchBase, "quoted-trim-"));
  writeFileSync(join(dir, "build.md"), '---\nname: "build "\n---\nBuild body.\n');

  const lib = await loadPromptLibrary(dir);
  expect(lib.has("build")).toBe(true);
  expect(lib.get("build")!.name).toBe("build");
});
