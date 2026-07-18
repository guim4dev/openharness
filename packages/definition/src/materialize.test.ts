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

test("writes a mandatory skill's SKILL.md so the materialized dir passes load (coherence gap fix)", async () => {
  const out = join(dir, "with-skill");
  const withSkill = {
    ...manifest,
    skills: [{ path: "skills/triage", mandatory: true }],
  };
  const skillMd = "---\nname: triage\ndescription: Triage incoming issues.\n---\nDo the triage.";
  const result = await writeHarnessDefinition(out, {
    manifest: withSkill,
    systemPrompt: "You are governed.",
    skills: [{ path: "skills/triage", content: skillMd }],
  });
  expect(result.files).toContain(join("skills/triage", "SKILL.md"));

  // The loader enforces that a MANDATORY skill has a SKILL.md — so this only
  // loads because materialize actually wrote it.
  const def = await loadHarnessDefinition(out);
  expect(def.skillDirs.length).toBe(1);
  expect(def.skillDirs[0].path).toContain("triage");
  expect(readFileSync(join(out, "skills/triage", "SKILL.md"), "utf8")).toContain("Do the triage.");
});

test("refuses a skill path that escapes the definition dir (traversal), writing nothing", async () => {
  const out = join(dir, "traversal");
  await expect(
    writeHarnessDefinition(out, {
      manifest,
      systemPrompt: "hi",
      skills: [{ path: "../../evil", content: "---\nname: evil\ndescription: x\n---\npwned" }],
    }),
  ).rejects.toThrow(MaterializeError);
});

test("atomicity: an escaping skill path writes NOTHING (validation precedes every write)", async () => {
  const out = join(dir, "atomic");
  const withMandatory = { ...manifest, skills: [{ path: "skills/triage", mandatory: true }] };
  await expect(
    writeHarnessDefinition(out, {
      manifest: withMandatory,
      systemPrompt: "hi",
      skills: [
        { path: "skills/triage", content: "---\nname: triage\ndescription: x\n---\nok" },
        { path: "../../evil", content: "pwned" }, // escapes → must abort before any write
      ],
    }),
  ).rejects.toThrow(MaterializeError);
  // No half-written, unloadable dir: base files were never written.
  expect(() => readFileSync(join(out, "harness.json"), "utf8")).toThrow();
  expect(() => readFileSync(join(out, "system-prompt.md"), "utf8")).toThrow();
});

test("rejects manifest fields it cannot materialize (appendSystemPrompt / promptLibrary / branding.icon)", async () => {
  let i = 0;
  for (const bad of [
    { ...manifest, appendSystemPrompt: "extra.md" },
    { ...manifest, promptLibrary: "lib" },
    { ...manifest, branding: { ...manifest.branding, icon: "icon.png" } },
  ]) {
    await expect(writeHarnessDefinition(join(dir, `unsupported${i++}`), { manifest: bad, systemPrompt: "x" })).rejects.toThrow(
      MaterializeError,
    );
  }
});

test("re-materializing without a policy removes a stale policy.json", async () => {
  const out = join(dir, "restale");
  await writeHarnessDefinition(out, { manifest, policy, systemPrompt: "hi" });
  expect(readFileSync(join(out, "policy.json"), "utf8")).toContain("deny");
  // Re-materialize with policy omitted → the stale enforcing file must be gone.
  const result = await writeHarnessDefinition(out, { manifest, systemPrompt: "hi" });
  expect(result.files).not.toContain("policy.json");
  expect(() => readFileSync(join(out, "policy.json"), "utf8")).toThrow();
  const def = await loadHarnessDefinition(out);
  expect(def.policy).toBeUndefined();
});

test("serializes the VALIDATED manifest — unknown keys never reach disk", async () => {
  const out = join(dir, "extrakeys");
  const withExtra = { ...manifest, sneaky: "should-be-stripped" };
  await writeHarnessDefinition(out, { manifest: withExtra, systemPrompt: "hi" });
  expect(readFileSync(join(out, "harness.json"), "utf8")).not.toContain("sneaky");
});
