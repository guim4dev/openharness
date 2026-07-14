import { expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPromptLibrary, resolvePrompt, PromptLibraryError } from "./load.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "..", "test-fixtures", name);

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
