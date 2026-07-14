import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { saveDefinition } from "./sidecar.ts";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "oh-sidecar-save-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const manifest = {
  name: "acme-assistant",
  version: "0.1.0",
  branding: { displayName: "Acme Assistant", accent: "#4F46E5" },
  systemPrompt: "system-prompt.md",
  skills: [],
  providers: { default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" } },
};
const policy = { default: "deny", rules: [{ match: "mcp__github__*", action: "ask" }] };

test("writes a builder-authored definition and reports a clean doctor", async () => {
  const result = await saveDefinition(
    { name: "acme-assistant", manifest, policy, systemPrompt: "You are governed." },
    { baseDir: base },
  );
  expect(result.ok).toBe(true);
  expect(result.dir).toBe(join(base, "acme-assistant"));
  expect(result.error).toBeUndefined();
  // The files are really there.
  expect(JSON.parse(await readFile(join(result.dir, "harness.json"), "utf8")).name).toBe("acme-assistant");
  expect(await readFile(join(result.dir, "system-prompt.md"), "utf8")).toContain("You are governed.");
});

test("sanitizes the name so a traversal attempt cannot escape the base dir", async () => {
  const result = await saveDefinition(
    { name: "../../evil", manifest, systemPrompt: "hi" },
    { baseDir: base },
  );
  // "../../evil" -> "evil" (only [a-z0-9-] kept); written strictly under base.
  expect(result.dir).toBe(join(base, "evil"));
  expect(dirname(result.dir)).toBe(base);
});

test("a name with no usable characters is refused", async () => {
  const result = await saveDefinition({ name: "!!!", manifest, systemPrompt: "hi" }, { baseDir: base });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/valid name/);
});

test("an invalid manifest fails closed with an error and no clean save", async () => {
  const bad = { ...manifest, providers: {} }; // missing required default provider
  const result = await saveDefinition({ name: "broken", manifest: bad, systemPrompt: "hi" }, { baseDir: base });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/manifest is invalid/);
});
