import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadHarnessDefinition, HarnessDefinitionError } from "./load.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "..", "test-fixtures", name);

test("loads a valid definition with absolute paths and prompt text", async () => {
  const def = await loadHarnessDefinition(fixture("valid"));
  expect(def.manifest.name).toBe("example");
  expect(def.systemPromptText).toContain("Acme Assistant");
  expect(def.skillDirs).toHaveLength(1);
  expect(
    def.skillDirs[0].path.endsWith("skills/triage") || def.skillDirs[0].path.endsWith("skills\\triage"),
  ).toBe(true);
});

test("throws a clear error when a mandatory skill dir has no SKILL.md", async () => {
  await expect(loadHarnessDefinition(fixture("missing-skill"))).rejects.toThrow(HarnessDefinitionError);
  await expect(loadHarnessDefinition(fixture("missing-skill"))).rejects.toThrow(/SKILL\.md/);
});
