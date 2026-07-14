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
 * Whether an npm package spec is pinned to a CONCRETE version. A concrete
 * version starts with a digit and carries no range/tag: `@1.2.3`, `@2025.9.0`,
 * or a prerelease `@1.2.3-beta.1`. Moving targets are NOT pinned — dist-tags
 * (`@latest`, `@next`, `@beta`) and ranges (`@^1.0.0`, `@~2`, `@1.x`, `@*`,
 * `@>=1`) all re-resolve on the next launch, exactly the risk this catches.
 * Non-registry specs (a local path, `file:`, a git/URL) aren't npx-latest
 * fetches, so they're treated as pinned (not flagged).
 */
function npmSpecIsPinned(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.includes(":")) return true;
  const body = spec.startsWith("@") ? spec.slice(1) : spec;
  const at = body.indexOf("@");
  if (at < 0) return false; // bare name, no version
  const version = body.slice(at + 1);
  // Concrete: first char a digit, and no range operator / wildcard anywhere.
  return /^\d/.test(version) && !/[\^~*xX><|\s]/.test(version);
}

/** A PyPI spec (uvx/uv) is pinned only by an exact `==<concrete>` (PEP 508). */
function pypiSpecIsPinned(spec: string): boolean {
  const m = /==\s*([^\s;,]+)/.exec(spec);
  return !!m && /^\d/.test(m[1]) && !/[\^~*xX><|]/.test(m[1]);
}

/** basename of a command path (`/usr/bin/npx` -> `npx`). */
function baseCommand(cmd: string): string {
  const slash = cmd.lastIndexOf("/");
  return slash >= 0 ? cmd.slice(slash + 1) : cmd;
}

/** First non-flag argument at or after `from`. */
function firstPositional(args: string[], from = 0): string | undefined {
  for (let i = from; i < args.length; i++) if (!args[i].startsWith("-")) return args[i];
  return undefined;
}

/**
 * A launch-time FETCH and whether its target is pinned. MCP servers are commonly
 * run through a package/container runner that re-resolves its target on each
 * launch — the Postmark-MCP class of supply-chain risk (a trusted upstream
 * silently ships a new, possibly malicious build). We recognize the npm family
 * (`npx`, `bunx`, `pnpm dlx`, `yarn dlx` — pinned by a concrete `@<version>`),
 * the PyPI family (`uvx`, `uv tool run`/`uv x` — pinned by `==<version>`), and
 * containers (`docker`/`podman run` — pinned ONLY by an `@sha256:` digest, since
 * a tag is mutable). A locally-installed binary fetches nothing → `undefined`.
 */
interface RunnerPin {
  runner: string;
  target: string;
  pinned: boolean;
  /** How to pin it, for the finding message. */
  hint: string;
}

function runnerPinStatus(command: string, args: string[]): RunnerPin | undefined {
  const base = baseCommand(command);
  const npm = (runner: string, target: string | undefined): RunnerPin | undefined =>
    target ? { runner, target, pinned: npmSpecIsPinned(target), hint: `${target}@<version>` } : undefined;
  const pypi = (runner: string, target: string | undefined): RunnerPin | undefined =>
    target ? { runner, target, pinned: pypiSpecIsPinned(target), hint: `${target}==<version>` } : undefined;

  if (base === "npx") return npm("npx", firstPositional(args));
  if (base === "bunx") return npm("bunx", firstPositional(args));
  if (base === "pnpm" && args[0] === "dlx") return npm("pnpm dlx", firstPositional(args, 1));
  if (base === "yarn" && args[0] === "dlx") return npm("yarn dlx", firstPositional(args, 1));
  if (base === "uvx") return pypi("uvx", firstPositional(args));
  if (base === "uv" && args[0] === "x") return pypi("uv x", firstPositional(args, 1));
  if (base === "uv" && args[0] === "tool" && args[1] === "run") return pypi("uv tool run", firstPositional(args, 2));
  if ((base === "docker" || base === "podman") && args.includes("run")) {
    // Pinned only when some argument IS a full image reference ending in a
    // content digest — `<name>[:tag]@sha256:<64hex>`, anchored. A digest merely
    // CONTAINED in an unrelated arg (e.g. `-e EXPECTED=@sha256:…`, whose token
    // carries an `=` outside the image-name charset) does NOT count — that false
    // negative would let a mutable `:latest` image ship silently.
    const pinned = args.some((a) => /^[a-z0-9._/:-]+@sha256:[0-9a-f]{64}$/i.test(a));
    const image = firstPositional(args, args.indexOf("run") + 1) ?? "<image>";
    return { runner: base, target: image, pinned, hint: `${image.split("@")[0].split(":")[0]}@sha256:<digest>` };
  }
  return undefined;
}

export interface RunDoctorOptions {
  /**
   * Escalate the MCP supply-chain pinning check from a warning to an error, so
   * `runDoctor().ok` is false (and `build` refuses) when any declared MCP server
   * is fetched unpinned. Off by default (unpinned still runs); a security-
   * conscious org opts in for a CI gate.
   */
  strictSupplyChain?: boolean;
}

export async function runDoctor(defDir: string, opts: RunDoctorOptions = {}): Promise<DoctorReport> {
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

  // 3b. A stdio MCP server run through a launch-time FETCHER (npx/bunx/pnpm dlx/
  //     yarn dlx, uvx/uv, docker/podman run) WITHOUT a pinned target re-resolves
  //     on every launch — the Postmark-MCP class of supply-chain risk (a trusted
  //     upstream silently ships a new build). Nudge pinning. Warn (not error):
  //     unpinned still works, and a locally-installed binary is never flagged.
  for (const [server, spec] of Object.entries(manifest.mcp?.servers ?? {})) {
    if (spec.transport !== "stdio" || !spec.command) continue;
    const run = runnerPinStatus(spec.command, spec.args ?? []);
    if (run && !run.pinned)
      problems.push({
        level: opts.strictSupplyChain ? "error" : "warn",
        code: "mcp-server-unpinned",
        message: `mcp server '${server}' runs '${run.target}' via ${run.runner} with no pinned ${run.runner === "docker" || run.runner === "podman" ? "digest" : "version"} — pin it ('${run.hint}') so a malicious or breaking upstream update can't auto-ship`,
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

    // 7. MCP egress ungoverned: a policy is in effect and MCP servers are
    //    declared, but the default is `allow` and NO rule governs `mcp__*`, so
    //    every bridged MCP tool reaches external systems on default-allow. The
    //    author clearly cares about governance (there IS a policy) yet left the
    //    egress surface open — nudge explicit `mcp__*` rules. Narrow trigger
    //    (default-allow + zero mcp rules) keeps this from firing on a policy that
    //    already governs MCP or that is deny-by-default.
    const hasMcpServers = Object.keys(manifest.mcp?.servers ?? {}).length > 0;
    const governsMcp = policy.rules.some((r) => {
      const m = r.match.replace(/\(.*\)$/s, "").trim();
      return m.startsWith("mcp__") || globMatch(m, "mcp__example__tool");
    });
    if (hasMcpServers && policy.default === "allow" && !governsMcp)
      problems.push({
        level: "warn",
        code: "mcp-egress-ungoverned",
        message:
          "MCP servers are declared but the policy leaves mcp__* on default-allow (no rule governs MCP egress) — those tools reach external systems ungoverned; add explicit mcp__* rules",
      });
  }

  const ok = !problems.some((p) => p.level === "error");
  return { ok, defName: `${manifest.name}@${manifest.version}`, problems };
}
