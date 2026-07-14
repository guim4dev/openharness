import { expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideTool } from "@openharness/policy";
import { loadHarnessDefinition } from "./load.ts";

// Realistic example harnesses under harnesses/ (see docs/DEMO.md). These mirror
// the shape of two Fable use cases with DISTINCT branding/prompts/mcp/policy —
// exercised here against the real HarnessDefinition + Policy loader, not a
// synthetic fixture, so a schema drift in either package is caught here too.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const harness = (name: string) => join(repoRoot, "harnesses", name);

test("acme-fintech loads cleanly: branding, mandatory skill, two non-mandatory MCP servers", async () => {
  const def = await loadHarnessDefinition(harness("acme-fintech"));
  expect(def.manifest.name).toBe("acme-fintech");
  expect(def.manifest.branding.displayName).toBe("Acme Engineer");
  expect(def.manifest.branding.accent).toBe("#0E7C61");
  expect(def.systemPromptText).toContain("Acme Engineer");

  expect(def.skillDirs).toHaveLength(1);
  expect(def.skillDirs[0].mandatory).toBe(true);
  expect(def.skillDirs[0].path.endsWith(join("skills", "incident-triage"))).toBe(true);

  const servers = def.manifest.mcp?.servers ?? {};
  expect(Object.keys(servers).sort()).toEqual(["analytics_readonly", "internal_docs"]);
  // Both MCP servers must be non-mandatory so this harness loads/bundles/builds
  // fully offline — nothing needs to be running to validate the definition.
  expect(servers.internal_docs.mandatory).toBe(false);
  expect(servers.analytics_readonly.mandatory).toBe(false);
  expect(servers.internal_docs.tools).toEqual(["read_file", "list_directory", "search_files"]);
  expect(servers.analytics_readonly.tools).toEqual(["query"]);

  // The analytics server's DB password is provisioned locally and referenced by
  // NAME via `secrets` (PGPASSWORD -> credential ref) — never a bare credential
  // baked into args. That ref is all that ships in the bundle.
  expect(servers.analytics_readonly.secrets).toEqual({ PGPASSWORD: "acme-analytics-ro" });
  const argsJoined = (servers.analytics_readonly.args ?? []).join(" ");
  expect(argsJoined).not.toMatch(/:[^@/]*@/); // no `user:password@host` credential in the connection string
});

test("acme-fintech's policy.json parses: deny-by-default, destructive-tool denies, model allow-list", async () => {
  const def = await loadHarnessDefinition(harness("acme-fintech"));
  expect(def.policy).toBeDefined();
  expect(def.policy?.default).toBe("deny");
  const matches = def.policy?.rules.map((r) => r.match) ?? [];
  expect(matches).toContain("mcp__*__delete_*");
  expect(matches).toContain("mcp__*__drop_*");
  expect(matches).toContain("bash(git *)");
  expect(def.policy?.models?.allow).toEqual(["anthropic/claude-*"]);
  expect(def.policy?.redact?.some((r) => r.pattern.startsWith("AKIA"))).toBe(true);
});

test("northwind-ops loads cleanly: branding, mandatory skill, one non-mandatory MCP server", async () => {
  const def = await loadHarnessDefinition(harness("northwind-ops"));
  expect(def.manifest.name).toBe("northwind-ops");
  expect(def.manifest.branding.displayName).toBe("Northwind Ops Copilot");
  expect(def.manifest.branding.accent).toBe("#E8590C");
  expect(def.systemPromptText).toContain("Northwind Ops Copilot");

  expect(def.skillDirs).toHaveLength(1);
  expect(def.skillDirs[0].mandatory).toBe(true);
  expect(def.skillDirs[0].path.endsWith(join("skills", "order-remediation"))).toBe(true);

  // Meaningfully different provider shape from acme-fintech: a second named
  // profile beyond `default`.
  expect(def.manifest.providers.batch?.provider).toBe("openai");

  const servers = def.manifest.mcp?.servers ?? {};
  expect(Object.keys(servers)).toEqual(["back_office"]);
  expect(servers.back_office.mandatory).toBe(false);
  expect(servers.back_office.tools).toContain("write_query");
});

test("northwind-ops's policy.json parses: ask-by-default for writes, reads allow-listed, distinct redact + models", async () => {
  const def = await loadHarnessDefinition(harness("northwind-ops"));
  expect(def.policy).toBeDefined();
  expect(def.policy?.default).toBe("ask");
  const readRule = def.policy?.rules.find((r) => r.match === "mcp__back_office__read_query");
  expect(readRule?.action).toBe("allow");
  const writeRule = def.policy?.rules.find((r) => r.match === "mcp__back_office__write_query");
  expect(writeRule?.action).toBe("ask");
  expect(def.policy?.models?.allow).toEqual(["anthropic/claude-*", "openai/gpt-5*"]);
  // Distinct redaction focus from acme-fintech (PII, not cloud/API secrets).
  expect(def.policy?.redact?.some((r) => r.replace === "[REDACTED_EMAIL]")).toBe(true);
});

test("northwind-ops enforces arg-level SQL control on write_query through decideTool (gap #2)", async () => {
  const def = await loadHarnessDefinition(harness("northwind-ops"));
  const policy = def.policy!;
  // A read is allowed outright.
  expect(
    decideTool(policy, "mcp__back_office__read_query", { query: "SELECT * FROM orders WHERE id = 42" }).decision,
  ).toBe("allow");
  // A DELETE write asks for confirmation (matched by the parameterized rule, not
  // the coarse whole-tool rule).
  expect(
    decideTool(policy, "mcp__back_office__write_query", { query: "DELETE FROM orders WHERE id = 42" }).decision,
  ).toBe("ask");
  // A DROP is denied outright — and case-insensitively, so lowercase `drop` is
  // caught too.
  expect(
    decideTool(policy, "mcp__back_office__write_query", { query: "drop table orders" }).decision,
  ).toBe("deny");
});

test("the two examples are meaningfully distinct in branding and policy default posture", async () => {
  const acme = await loadHarnessDefinition(harness("acme-fintech"));
  const northwind = await loadHarnessDefinition(harness("northwind-ops"));
  expect(acme.manifest.branding.accent).not.toBe(northwind.manifest.branding.accent);
  expect(acme.manifest.branding.displayName).not.toBe(northwind.manifest.branding.displayName);
  expect(acme.policy?.default).not.toBe(northwind.policy?.default);
});
