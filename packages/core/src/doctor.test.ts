import { afterAll, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./doctor.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const tmps: string[] = [];

afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

type Manifest = Record<string, unknown>;

/** Write a minimal definition dir (harness.json + system-prompt.md + optional policy.json). */
function writeDef(manifest: Manifest, policy?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "oh-doctor-"));
  tmps.push(dir);
  writeFileSync(join(dir, "harness.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "system-prompt.md"), "You are a test harness.\n");
  if (policy !== undefined) writeFileSync(join(dir, "policy.json"), JSON.stringify(policy, null, 2));
  return dir;
}

function baseManifest(over: Manifest = {}): Manifest {
  return {
    name: "doc-test",
    version: "0.1.0",
    branding: { displayName: "Doc Test" },
    systemPrompt: "system-prompt.md",
    skills: [],
    providers: { default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" } },
    ...over,
  };
}

function codes(problems: { code: string }[]): string[] {
  return problems.map((p) => p.code);
}

test("a clean example harness passes with no error-level problems", async () => {
  const report = await runDoctor(join(repoRoot, "harnesses", "meridian-support"));
  expect(report.ok).toBe(true);
  expect(report.problems.filter((p) => p.level === "error")).toHaveLength(0);
  expect(report.defName).toBe("meridian-support@0.1.0");
});

test("a dir with no harness.json fails loud as load-failed (ok=false)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-doctor-empty-"));
  tmps.push(dir);
  const report = await runDoctor(dir);
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("load-failed");
});

test("a model denied by the harness's OWN policy is an error", async () => {
  const dir = writeDef(baseManifest(), {
    default: "allow",
    rules: [],
    models: { allow: ["openai/gpt-5*"] }, // default is anthropic/claude-sonnet-5 -> denied
  });
  const report = await runDoctor(dir);
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("model-denied-by-own-policy");
});

test("default-deny with no allow/ask rule is a warning, not an error", async () => {
  const dir = writeDef(baseManifest(), { default: "deny", rules: [] });
  const report = await runDoctor(dir);
  expect(codes(report.problems)).toContain("deny-all");
  expect(report.ok).toBe(true); // warning only
});

test("default-deny with only ask rules does NOT warn deny-all (ask tools run on approval)", async () => {
  const dir = writeDef(baseManifest(), { default: "deny", rules: [{ match: "read", action: "ask" }] });
  const report = await runDoctor(dir);
  expect(codes(report.problems)).not.toContain("deny-all");
  expect(report.ok).toBe(true);
});

test("a non-default provider profile denied by policy is a WARNING (not a build-blocking error)", async () => {
  const dir = writeDef(
    baseManifest({
      providers: {
        default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" },
        cheap: { provider: "openai", model: "gpt-5-mini", credentialProfile: "batch" },
      },
    }),
    { default: "allow", rules: [], models: { allow: ["anthropic/claude-*"] } },
  );
  const report = await runDoctor(dir);
  expect(codes(report.problems)).toContain("model-denied-by-own-policy");
  expect(report.ok).toBe(true); // non-default → warn, so ok stays true
});

test("a referenced branding.icon that does not exist is an error", async () => {
  const dir = writeDef(baseManifest({ branding: { displayName: "Doc Test", icon: "branding/icon.png" } }));
  const report = await runDoctor(dir);
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("icon-missing");
});

test("an MCP secret ref in the reserved api-key: namespace is an error", async () => {
  const dir = writeDef(
    baseManifest({
      mcp: {
        servers: {
          backoffice: { transport: "http", url: "https://x.internal", secrets: { Authorization: "api-key:my-anthropic" } },
        },
      },
    }),
  );
  const report = await runDoctor(dir);
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("mcp-secret-reserved-namespace");
});

test("a mandatory MCP server with every declared tool denied is a warning", async () => {
  const dir = writeDef(
    baseManifest({
      mcp: {
        servers: {
          db: { transport: "stdio", command: "npx", args: ["-y", "srv"], mandatory: true, tools: ["write_query"] },
        },
      },
    }),
    { default: "allow", rules: [{ match: "mcp__db__write_query", action: "deny" }] },
  );
  const report = await runDoctor(dir);
  expect(codes(report.problems)).toContain("mandatory-mcp-all-denied");
});

test("a parameterized allow rule suppresses the mandatory-mcp-all-denied false positive", async () => {
  // `read(SELECT*)` allows the tool for real (arg-dependent) queries; judging with
  // empty args would wrongly see "deny" and cry "can do nothing". The param-rule
  // guard must skip the check here.
  const dir = writeDef(
    baseManifest({
      mcp: {
        servers: {
          db: { transport: "stdio", command: "npx", args: ["-y", "srv"], mandatory: true, tools: ["read"] },
        },
      },
    }),
    { default: "deny", rules: [{ match: "mcp__db__read(SELECT*)", action: "allow" }] },
  );
  const report = await runDoctor(dir);
  expect(codes(report.problems)).not.toContain("mandatory-mcp-all-denied");
});
