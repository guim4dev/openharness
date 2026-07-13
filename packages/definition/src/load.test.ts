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

test("loads an optional policy.json into the definition", async () => {
  const def = await loadHarnessDefinition(fixture("with-policy"));
  expect(def.policy).toBeDefined();
  expect(def.policy?.default).toBe("allow");
  expect(def.policy?.rules).toHaveLength(2);
  expect(def.policy?.redact?.[0].replace).toBe("sk-REDACTED");
});

test("policy is undefined when no policy.json is present (backward compatible)", async () => {
  const def = await loadHarnessDefinition(fixture("valid"));
  expect(def.policy).toBeUndefined();
});

test("throws a clear error when policy.json is invalid", async () => {
  await expect(loadHarnessDefinition(fixture("bad-policy"))).rejects.toThrow(HarnessDefinitionError);
  await expect(loadHarnessDefinition(fixture("bad-policy"))).rejects.toThrow(/policy/i);
});
