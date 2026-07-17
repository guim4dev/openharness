import { afterAll, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarnessDefinition } from "./load.ts";
import { ScaffoldError, scaffoldHarness } from "./scaffold.ts";

// Fresh temp base per test file run; each test scaffolds into its own
// not-yet-existing subdir so tests never collide.
const base = mkdtempSync(join(tmpdir(), "oh-scaffold-test-"));

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

test("scaffolds a harness that loadHarnessDefinition accepts, whose policy.json parses", async () => {
  const dir = join(base, "my-harness");
  const result = await scaffoldHarness(dir);
  expect(result.rootDir).toBe(dir);
  expect(result.name).toBe("my-harness");

  const def = await loadHarnessDefinition(dir);
  expect(def.manifest.name).toBe("my-harness");
  expect(def.manifest.version).toBe("0.1.0");
  expect(def.manifest.branding.displayName).toBe("My Harness");
  expect(def.manifest.providers.default).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-5",
    credentialProfile: "work",
  });
  expect(def.systemPromptText.length).toBeGreaterThan(0);

  // one mandatory skill
  expect(def.skillDirs).toHaveLength(1);
  expect(def.skillDirs[0].mandatory).toBe(true);
  expect(existsSync(join(def.skillDirs[0].path, "SKILL.md"))).toBe(true);

  // policy.json is present and parses
  expect(def.policy).toBeDefined();
  expect(def.policy?.default).toBe("allow");
  expect(def.policy?.rules.length).toBeGreaterThan(0);
  expect(def.policy?.redact?.length).toBeGreaterThan(0);

  // The starter governs MCP egress up front (secure-by-default): destructive
  // ops denied, other mutations ask — inert until an mcp block is added.
  const mcpRules = def.policy!.rules.filter((r) => r.match.startsWith("mcp__"));
  expect(mcpRules.some((r) => r.action === "deny")).toBe(true);
  expect(mcpRules.some((r) => r.action === "ask")).toBe(true);

  // no mcp section by default — stays trivially runnable/offline
  expect(def.manifest.mcp).toBeUndefined();
});

test("--name/--display/--provider/--model overrides are honored", async () => {
  const dir = join(base, "some-dir-name");
  const result = await scaffoldHarness(dir, {
    name: "custom-name",
    displayName: "Custom Display",
    provider: "openai",
    model: "gpt-5-mini",
  });
  expect(result.name).toBe("custom-name");

  const def = await loadHarnessDefinition(dir);
  expect(def.manifest.name).toBe("custom-name");
  expect(def.manifest.branding.displayName).toBe("Custom Display");
  expect(def.manifest.providers.default.provider).toBe("openai");
  expect(def.manifest.providers.default.model).toBe("gpt-5-mini");
});

test("name defaults to the dir basename when --name is omitted", async () => {
  const dir = join(base, "basename-wins");
  await scaffoldHarness(dir, { displayName: "Overridden Display Only" });
  const def = await loadHarnessDefinition(dir);
  expect(def.manifest.name).toBe("basename-wins");
  expect(def.manifest.branding.displayName).toBe("Overridden Display Only");
});

test("throws a clear ScaffoldError when the target dir exists and is non-empty; never overwrites", async () => {
  const dir = join(base, "existing-nonempty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stray.txt"), "pre-existing content");

  await expect(scaffoldHarness(dir)).rejects.toThrow(ScaffoldError);
  await expect(scaffoldHarness(dir)).rejects.toThrow(/not empty|already exists/i);

  // untouched: the stray file is still there, nothing was written alongside it
  expect(existsSync(join(dir, "stray.txt"))).toBe(true);
  expect(existsSync(join(dir, "harness.json"))).toBe(false);
});

test("an empty EXISTING dir is fine (not treated as non-empty)", async () => {
  const dir = join(base, "existing-empty");
  mkdirSync(dir, { recursive: true });
  const result = await scaffoldHarness(dir);
  expect(result.name).toBe("existing-empty");
  expect(existsSync(join(dir, "harness.json"))).toBe(true);
});

test("creates parent dirs as needed for a nested, not-yet-existing path", async () => {
  const dir = join(base, "nested", "a", "b");
  expect(existsSync(dir)).toBe(false);
  await scaffoldHarness(dir);
  expect(existsSync(join(dir, "harness.json"))).toBe(true);
});
