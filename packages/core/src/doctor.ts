import { access } from "node:fs/promises";
import { join } from "node:path";
import { HarnessDefinitionError, loadHarnessDefinition } from "@openharness/definition";
import { checkModel, decideTool, globMatch } from "@openharness/policy";

/**
 * `openharness doctor` — preflight a HarnessDefinition without building it.
 *
 * `loadHarnessDefinition` already fails loud on structural/reference problems
 * (missing/invalid harness.json, an unresolved systemPrompt/promptLibrary ref, a
 * mandatory skill missing SKILL.md, a malformed policy). `doctor` runs that first
 * (surfacing any failure as a single `load-failed` error), then adds the
 * self-consistency checks the loader intentionally does NOT make — the ones that
 * only bite later, at build or at first run.
 */
export type DoctorLevel = "error" | "warn";

export interface DoctorProblem {
  level: DoctorLevel;
  /** Stable kebab-case identifier for the check that fired. */
  code: string;
  message: string;
}

export interface DoctorReport {
  /** True when no `error`-level problem was found (warnings do not fail). */
  ok: boolean;
  /** `<name>@<version>` once the definition loads; absent if load itself failed. */
  defName?: string;
  problems: DoctorProblem[];
}

/** Must mirror the mcp package's `LLM_CREDENTIAL_NAMESPACE` (`/^api-key:/`). */
const RESERVED_CRED_NAMESPACE = "api-key:";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an npm package spec carries a version pin. Scoped specs
 * (`@scope/name`) are pinned only when an `@version` follows the scope
 * (`@scope/name@1.2.3`); unscoped when they contain any `@` (`name@1.2.3`).
 */
function npmSpecIsPinned(spec: string): boolean {
  const body = spec.startsWith("@") ? spec.slice(1) : spec;
  return body.includes("@");
}

export async function runDoctor(defDir: string): Promise<DoctorReport> {
  const problems: DoctorProblem[] = [];

  let def;
  try {
    def = await loadHarnessDefinition(defDir);
  } catch (e) {
    const message = e instanceof HarnessDefinitionError ? e.message : String((e as Error)?.message ?? e);
    return { ok: false, problems: [{ level: "error", code: "load-failed", message }] };
  }

  const { manifest, rootDir, policy } = def;

  // 1. branding.icon is referenced but the file is absent. The loader records
  //    iconPath without checking existence; `openharness build` needs the file.
  if (manifest.branding.icon) {
    const iconAbs = join(rootDir, manifest.branding.icon);
    if (!(await pathExists(iconAbs)))
      problems.push({
        level: "error",
        code: "icon-missing",
        message: `branding.icon '${manifest.branding.icon}' not found at ${iconAbs}`,
      });
  }

  // 2. An OPTIONAL skill dir with no SKILL.md. The loader enforces SKILL.md only
  //    for mandatory skills, so a typo'd optional skill would silently do nothing.
  for (const s of manifest.skills) {
    if (s.mandatory) continue;
    const skillMd = join(rootDir, s.path, "SKILL.md");
    if (!(await pathExists(skillMd)))
      problems.push({
        level: "warn",
        code: "skill-missing-skillmd",
        message: `optional skill '${s.path}' has no SKILL.md at ${skillMd} — it will contribute nothing`,
      });
  }

  // 3. An MCP secret ref in the reserved LLM-credential namespace. The mcp client
  //    refuses to connect on such a ref (an LLM key must never be resolvable as an
  //    MCP header/env); surface it before build/connect.
  for (const [server, spec] of Object.entries(manifest.mcp?.servers ?? {})) {
    for (const [key, ref] of Object.entries(spec.secrets ?? {})) {
      if (ref.startsWith(RESERVED_CRED_NAMESPACE))
        problems.push({
          level: "error",
          code: "mcp-secret-reserved-namespace",
          message: `mcp server '${server}' maps '${key}' to reserved ref '${ref}' — the ${RESERVED_CRED_NAMESPACE}* namespace is rejected at connect`,
        });
    }
  }

  // 3b. A stdio MCP server run via `npx` WITHOUT a pinned version fetches the
  //     registry's "latest" on every launch — a supply-chain risk (a malicious or
  //     breaking upstream update auto-ships, the Postmark-MCP class of incident).
  //     Nudge pinning `<pkg>@<version>`. Warn (not error): unpinned still works.
  for (const [server, spec] of Object.entries(manifest.mcp?.servers ?? {})) {
    if (spec.transport !== "stdio") continue;
    const cmd = spec.command ?? "";
    if (cmd !== "npx" && !cmd.endsWith("/npx")) continue;
    const pkg = (spec.args ?? []).find((a) => !a.startsWith("-"));
    if (pkg && !npmSpecIsPinned(pkg))
      problems.push({
        level: "warn",
        code: "mcp-server-unpinned",
        message: `mcp server '${server}' runs '${pkg}' via npx with no pinned version — pin it ('${pkg}@<version>') so a malicious or breaking upstream update can't auto-ship`,
      });
  }

  if (policy) {
    // 4. A provider profile's model is denied by the harness's OWN policy.models.
    //    The DEFAULT profile is gated at session start, so a denied default can't
    //    even start the harness → error. A non-default profile is only gated on
    //    an explicit switch, so a denied one is a latent misconfig → warn.
    for (const [profile, cfg] of Object.entries(manifest.providers)) {
      if (checkModel(policy, cfg.provider, cfg.model) !== "deny") continue;
      const isDefault = profile === "default";
      problems.push({
        level: isDefault ? "error" : "warn",
        code: "model-denied-by-own-policy",
        message: isDefault
          ? `provider profile 'default' uses ${cfg.provider}/${cfg.model}, which this harness's own policy.models denies — it cannot start`
          : `provider profile '${profile}' uses ${cfg.provider}/${cfg.model}, which this harness's own policy.models denies — it would fail if switched to`,
      });
    }

    // 5. default "deny" with no allow OR ask rule anywhere — the harness can run
    //    no tool at all. `ask` counts as usable: an ask-matched tool prompts a
    //    human and runs on approval, so a policy with `ask` rules is NOT deny-all.
    if (policy.default === "deny" && !policy.rules.some((r) => r.action === "allow" || r.action === "ask"))
      problems.push({
        level: "warn",
        code: "deny-all",
        message: `policy default is "deny" and no rule allows or asks — the harness can run no tools`,
      });

    // 6. A mandatory MCP server whose EVERY declared tool is denied by policy.
    //    It must connect yet can do nothing — almost always a mistake. Judged
    //    with empty args, so a PARAMETERIZED rule (`tool(<glob>)`) — which decides
    //    on arg content we don't have at preflight — would mis-call it. Skip the
    //    check for a server any of whose tools a parameterized rule targets (bias
    //    to a missed warning over a false one). Servers without a `tools`
    //    allowlist are skipped too (we can't enumerate what they'd expose).
    const paramRuleTargets = (tool: string): boolean =>
      policy.rules.some(
        (r) => r.match.includes("(") && globMatch(r.match.replace(/\(.*\)$/s, "").trim(), tool),
      );
    for (const [server, spec] of Object.entries(manifest.mcp?.servers ?? {})) {
      if (!spec.mandatory) continue;
      const tools = spec.tools ?? [];
      if (tools.length === 0) continue;
      if (tools.some((t) => paramRuleTargets(`mcp__${server}__${t}`))) continue;
      const allDenied = tools.every((t) => decideTool(policy, `mcp__${server}__${t}`, {}).decision === "deny");
      if (allDenied)
        problems.push({
          level: "warn",
          code: "mandatory-mcp-all-denied",
          message: `mandatory mcp server '${server}' has all ${tools.length} declared tool(s) denied by policy — it must connect but can do nothing`,
        });
    }
  }

  const ok = !problems.some((p) => p.level === "error");
  return { ok, defName: `${manifest.name}@${manifest.version}`, problems };
}
