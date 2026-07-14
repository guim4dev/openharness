import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeHarnessDefinition } from "@openharness/definition";
import { runDoctor } from "./doctor.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oh-mat-doctor-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * The shape the visual builder emits (draftToManifest/draftToPolicy). This test
 * closes the loop: a builder-shaped definition, materialized to disk, passes
 * `openharness doctor` — so what the visual builder produces is a real, valid,
 * doctor-clean definition, not just plausible JSON.
 */
const builderManifest = {
  name: "acme-assistant",
  version: "0.1.0",
  branding: { displayName: "Acme Assistant", accent: "#4F46E5" },
  systemPrompt: "system-prompt.md",
  skills: [],
  providers: { default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" } },
  mcp: { servers: { github: { transport: "stdio", command: "npx", tools: ["list_issues"] } } },
};
const builderPolicy = {
  default: "deny",
  rules: [{ match: "mcp__github__*", action: "ask" }],
};

test("a builder-shaped definition materializes to a doctor-clean directory", async () => {
  const out = join(dir, "def");
  await writeHarnessDefinition(out, { manifest: builderManifest, policy: builderPolicy, systemPrompt: "You are governed." });

  const report = await runDoctor(out);
  const errors = report.problems.filter((p) => p.level === "error");
  expect(errors).toEqual([]);
  expect(report.ok).toBe(true);
});

test("an unpinned MCP server in the builder output surfaces the supply-chain warning (still ok)", async () => {
  const out = join(dir, "unpinned");
  const manifest = {
    ...builderManifest,
    mcp: { servers: { github: { transport: "stdio", command: "npx", args: ["-y", "srv"] } } },
  };
  await writeHarnessDefinition(out, { manifest, policy: builderPolicy, systemPrompt: "hi" });

  const report = await runDoctor(out);
  expect(report.ok).toBe(true); // a warning, not an error
  expect(report.problems.some((p) => p.code === "mcp-server-unpinned")).toBe(true);
});
