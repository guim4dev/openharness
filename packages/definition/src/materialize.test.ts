import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHarnessDefinition } from "./load.ts";
import { MaterializeError, writeHarnessDefinition } from "./materialize.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oh-materialize-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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

test("writes a definition that loads via loadHarnessDefinition", async () => {
  const out = join(dir, "def");
  const result = await writeHarnessDefinition(out, { manifest, policy, systemPrompt: "You are governed." });
  expect(result.files).toEqual(["harness.json", "system-prompt.md", "policy.json"]);

  const def = await loadHarnessDefinition(out);
  expect(def.manifest.name).toBe("acme-assistant");
  expect(def.systemPromptText).toBe("You are governed.\n");
  expect(def.policy?.default).toBe("deny");
});

test("omits policy.json when no policy is given", async () => {
  const out = join(dir, "nopolicy");
  const result = await writeHarnessDefinition(out, { manifest, systemPrompt: "hi" });
  expect(result.files).not.toContain("policy.json");
  const def = await loadHarnessDefinition(out);
  expect(def.policy).toBeUndefined();
});

test("fail-closed: an invalid manifest throws and writes nothing", async () => {
  const out = join(dir, "bad");
  const bad = { ...manifest, providers: {} }; // missing required default provider
  await expect(writeHarnessDefinition(out, { manifest: bad, systemPrompt: "x" })).rejects.toBeInstanceOf(MaterializeError);
  // Nothing was written.
  expect(() => readFileSync(join(out, "harness.json"), "utf8")).toThrow();
});

test("rejects a manifest whose systemPrompt is not system-prompt.md", async () => {
  const out = join(dir, "wrongprompt");
  const bad = { ...manifest, systemPrompt: "prompt.txt" };
  await expect(writeHarnessDefinition(out, { manifest: bad, systemPrompt: "x" })).rejects.toThrow(/system-prompt\.md/);
});
