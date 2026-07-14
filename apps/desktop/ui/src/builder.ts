import { useCallback, useMemo, useReducer } from "react";

/**
 * Visual harness builder — a pure, browser-safe model for authoring a harness
 * definition WITHOUT hand-editing JSON. It holds an editable draft, folds edits
 * through a reducer, serializes to the on-disk `harness.json` + `policy.json`
 * shapes, round-trips an existing definition back into the form, and does cheap
 * live validation for UX. The AUTHORITATIVE gate stays `openharness doctor` on
 * the produced files — this deliberately imports no workspace package (no
 * node-fs) so it bundles for the browser.
 */

export type PolicyAction = "allow" | "deny" | "ask";
export type McpTransport = "stdio" | "http";

export interface BuilderRule {
  match: string;
  action: PolicyAction;
}

export interface BuilderSkill {
  path: string;
  mandatory: boolean;
}

export interface BuilderMcpServer {
  name: string;
  transport: McpTransport;
  /** stdio: launch command (a runner like `npx` should pin its target). */
  command: string;
  /** http: endpoint URL. */
  url: string;
  /** Comma-separated tool allowlist; empty = expose all the server offers. */
  tools: string;
}

export interface BuilderDraft {
  /** Slug: lowercase letters, digits, hyphens. */
  name: string;
  displayName: string;
  /** 6-digit hex accent, e.g. #4F46E5. */
  accent: string;
  /** The system prompt TEXT (written to system-prompt.md; the manifest points at it). */
  systemPrompt: string;
  provider: string;
  model: string;
  credentialProfile: string;
  policyDefault: PolicyAction;
  rules: BuilderRule[];
  skills: BuilderSkill[];
  mcpServers: BuilderMcpServer[];
  /**
   * Manifest fields the builder does NOT edit (version, `gateway` — including its
   * pinned pubkey — `appendSystemPrompt`, `promptLibrary`, extra provider
   * profiles, `branding.icon`, …), carried verbatim from a loaded definition so a
   * load→edit→save round-trip never silently drops them. Absent for a fresh draft.
   */
  carry?: Record<string, unknown>;
}

export const emptyDraft: BuilderDraft = {
  name: "",
  displayName: "",
  accent: "#4F46E5",
  systemPrompt: "",
  provider: "anthropic",
  model: "claude-sonnet-5",
  credentialProfile: "work",
  policyDefault: "deny",
  rules: [],
  skills: [],
  mcpServers: [],
};

export type BuilderScalarField =
  | "name"
  | "displayName"
  | "accent"
  | "systemPrompt"
  | "provider"
  | "model"
  | "credentialProfile"
  | "policyDefault";

export type BuilderAction =
  | { type: "setField"; field: BuilderScalarField; value: string }
  | { type: "addRule" }
  | { type: "updateRule"; index: number; patch: Partial<BuilderRule> }
  | { type: "removeRule"; index: number }
  | { type: "addSkill" }
  | { type: "updateSkill"; index: number; patch: Partial<BuilderSkill> }
  | { type: "removeSkill"; index: number }
  | { type: "addMcp" }
  | { type: "updateMcp"; index: number; patch: Partial<BuilderMcpServer> }
  | { type: "removeMcp"; index: number }
  | { type: "load"; draft: BuilderDraft };

const NEW_RULE: BuilderRule = { match: "", action: "deny" };
const NEW_SKILL: BuilderSkill = { path: "", mandatory: true };
const NEW_MCP: BuilderMcpServer = { name: "", transport: "stdio", command: "", url: "", tools: "" };

function replaceAt<T>(list: T[], index: number, patch: Partial<T>): T[] {
  return list.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

export function builderReducer(draft: BuilderDraft, action: BuilderAction): BuilderDraft {
  switch (action.type) {
    case "setField":
      return { ...draft, [action.field]: action.value };
    case "addRule":
      return { ...draft, rules: [...draft.rules, { ...NEW_RULE }] };
    case "updateRule":
      return { ...draft, rules: replaceAt(draft.rules, action.index, action.patch) };
    case "removeRule":
      return { ...draft, rules: draft.rules.filter((_, i) => i !== action.index) };
    case "addSkill":
      return { ...draft, skills: [...draft.skills, { ...NEW_SKILL }] };
    case "updateSkill":
      return { ...draft, skills: replaceAt(draft.skills, action.index, action.patch) };
    case "removeSkill":
      return { ...draft, skills: draft.skills.filter((_, i) => i !== action.index) };
    case "addMcp":
      return { ...draft, mcpServers: [...draft.mcpServers, { ...NEW_MCP }] };
    case "updateMcp":
      return { ...draft, mcpServers: replaceAt(draft.mcpServers, action.index, action.patch) };
    case "removeMcp":
      return { ...draft, mcpServers: draft.mcpServers.filter((_, i) => i !== action.index) };
    case "load":
      return { ...action.draft };
    default:
      return draft;
  }
}

/**
 * Mirror of `@openharness/policy`'s `isMalformedMatch` — replicated here because
 * this model is browser-safe (imports no workspace package). A `match` with
 * parens must be a well-formed `name(<glob>)` with balanced inner parens;
 * otherwise `parsePolicy` (inside doctor) rejects it, so we flag it live too.
 */
const PARAMETERIZED = /^([^()]+)\((.*)\)$/s;
function matchIsMalformed(match: string): boolean {
  if (!match.includes("(") && !match.includes(")")) return false;
  const m = PARAMETERIZED.exec(match);
  if (!m) return true;
  let depth = 0;
  for (const ch of m[2]) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return true;
  }
  return depth !== 0;
}

/** Parse a comma-separated tool allowlist into a trimmed, non-empty array. */
function parseTools(csv: string): string[] {
  return csv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** The `harness.json` object for a draft (systemPrompt lives in a sibling file). */
export function draftToManifest(draft: BuilderDraft): Record<string, unknown> {
  // Start from the carried original (minus the fields the builder OWNS), so
  // version/gateway/appendSystemPrompt/promptLibrary/extra-providers/icon survive
  // a round-trip; then overlay the edited fields.
  const carry = (draft.carry ?? {}) as Record<string, unknown>;
  const { branding: cBranding, providers: cProviders, mcp: _cMcp, ...rest } = carry;
  const carryBranding = (cBranding ?? {}) as Record<string, unknown>;
  const carryProviders = (cProviders ?? {}) as Record<string, unknown>;
  const manifest: Record<string, unknown> = {
    ...rest,
    name: draft.name,
    version: typeof rest.version === "string" ? rest.version : "0.1.0",
    branding: { ...carryBranding, displayName: draft.displayName, accent: draft.accent },
    systemPrompt: "system-prompt.md",
    skills: draft.skills.map((s) => ({ path: s.path, mandatory: s.mandatory })),
    providers: {
      ...carryProviders,
      default: { provider: draft.provider, model: draft.model, credentialProfile: draft.credentialProfile },
    },
  };
  if (draft.mcpServers.length > 0) {
    const servers: Record<string, unknown> = {};
    for (const m of draft.mcpServers) {
      const tools = parseTools(m.tools);
      servers[m.name] = {
        transport: m.transport,
        ...(m.transport === "stdio" ? { command: m.command } : { url: m.url }),
        ...(tools.length > 0 ? { tools } : {}),
      };
    }
    manifest.mcp = { servers };
  }
  return manifest;
}

/** The `policy.json` object for a draft. */
export function draftToPolicy(draft: BuilderDraft): Record<string, unknown> {
  return {
    default: draft.policyDefault,
    rules: draft.rules.map((r) => ({ match: r.match, action: r.action })),
  };
}

/** Load an existing manifest (+ optional policy + prompt text) into an editable draft. */
export function draftFromManifest(
  manifest: Record<string, unknown>,
  policy?: Record<string, unknown>,
  systemPromptText = "",
): BuilderDraft {
  const branding = (manifest.branding ?? {}) as Record<string, unknown>;
  const providers = (manifest.providers ?? {}) as Record<string, unknown>;
  const def = (providers.default ?? {}) as Record<string, unknown>;
  const rawRules = Array.isArray(policy?.rules) ? (policy!.rules as Record<string, unknown>[]) : [];
  const rawSkills = Array.isArray(manifest.skills) ? (manifest.skills as Record<string, unknown>[]) : [];
  const mcpServers = ((manifest.mcp as Record<string, unknown>)?.servers ?? {}) as Record<string, Record<string, unknown>>;
  return {
    name: String(manifest.name ?? ""),
    displayName: String(branding.displayName ?? ""),
    accent: String(branding.accent ?? emptyDraft.accent),
    systemPrompt: systemPromptText,
    provider: String(def.provider ?? emptyDraft.provider),
    model: String(def.model ?? emptyDraft.model),
    credentialProfile: String(def.credentialProfile ?? emptyDraft.credentialProfile),
    policyDefault: (policy?.default as PolicyAction) ?? "deny",
    rules: rawRules.map((r) => ({ match: String(r.match ?? ""), action: (r.action as PolicyAction) ?? "deny" })),
    skills: rawSkills.map((s) => ({ path: String(s.path ?? ""), mandatory: Boolean(s.mandatory) })),
    mcpServers: Object.entries(mcpServers).map(([name, spec]) => ({
      name,
      transport: (spec.transport as McpTransport) ?? "stdio",
      command: String(spec.command ?? ""),
      url: String(spec.url ?? ""),
      tools: Array.isArray(spec.tools) ? (spec.tools as string[]).join(", ") : "",
    })),
    // Preserve the full original so fields the form doesn't edit (version,
    // gateway pin, extra providers, appendSystemPrompt, promptLibrary, icon)
    // survive a load→edit→save round-trip.
    carry: manifest,
  };
}

export interface BuilderProblem {
  /** Dotted path of the offending field (e.g. `accent`, `rules.0.match`); absent for cross-field problems. */
  field?: string;
  message: string;
}

/**
 * Cheap, synchronous validation for live UX feedback — mirrors the manifest
 * schema's shape rules and a couple of doctor heuristics. Not authoritative:
 * `openharness doctor` on the written files is the real gate.
 */
export function validateDraft(draft: BuilderDraft): BuilderProblem[] {
  const problems: BuilderProblem[] = [];
  const req = (v: string, field: string, label: string) => {
    if (!v.trim()) problems.push({ field, message: `${label} is required.` });
  };
  req(draft.name, "name", "Name");
  if (draft.name.trim() && !/^[a-z0-9-]+$/.test(draft.name))
    problems.push({ field: "name", message: "Name must be lowercase letters, digits, and hyphens." });
  req(draft.displayName, "displayName", "Display name");
  if (!/^#[0-9a-fA-F]{6}$/.test(draft.accent))
    problems.push({ field: "accent", message: "Accent must be a 6-digit hex color like #4F46E5." });
  req(draft.systemPrompt, "systemPrompt", "System prompt");
  req(draft.provider, "provider", "Provider");
  req(draft.model, "model", "Model");
  req(draft.credentialProfile, "credentialProfile", "Credential profile");
  draft.rules.forEach((r, i) => {
    if (!r.match.trim()) problems.push({ field: `rules.${i}.match`, message: `Rule ${i + 1} needs a match pattern.` });
    else if (matchIsMalformed(r.match))
      problems.push({
        field: `rules.${i}.match`,
        message: `Rule ${i + 1} match '${r.match}' is malformed — a parameterized match must be name(<glob>) with balanced parentheses.`,
      });
  });
  draft.skills.forEach((s, i) => {
    if (!s.path.trim()) problems.push({ field: `skills.${i}.path`, message: `Skill ${i + 1} needs a path.` });
  });
  const seen = new Set<string>();
  draft.mcpServers.forEach((m, i) => {
    if (!m.name.trim()) problems.push({ field: `mcp.${i}.name`, message: `MCP server ${i + 1} needs a name.` });
    else if (seen.has(m.name)) problems.push({ field: `mcp.${i}.name`, message: `MCP server name '${m.name}' is duplicated.` });
    else seen.add(m.name);
    if (m.transport === "stdio") req(m.command, `mcp.${i}.command`, `MCP server ${i + 1} command`);
    else req(m.url, `mcp.${i}.url`, `MCP server ${i + 1} URL`);
  });
  // Mirror doctor's "deny default with no allow/ask" trap.
  if (draft.policyDefault === "deny" && draft.rules.length > 0 && !draft.rules.some((r) => r.action !== "deny"))
    problems.push({ message: "Default is deny and no rule allows or asks — the harness can run no tools." });
  return problems;
}

/** True when the draft has no validation problems. */
export function draftIsValid(draft: BuilderDraft): boolean {
  return validateDraft(draft).length === 0;
}

export interface UseBuilder {
  draft: BuilderDraft;
  problems: BuilderProblem[];
  valid: boolean;
  /** Live `harness.json` object for the current draft. */
  manifest: Record<string, unknown>;
  /** Live `policy.json` object for the current draft. */
  policy: Record<string, unknown>;
  setField: (field: BuilderScalarField, value: string) => void;
  addRule: () => void;
  updateRule: (index: number, patch: Partial<BuilderRule>) => void;
  removeRule: (index: number) => void;
  addSkill: () => void;
  updateSkill: (index: number, patch: Partial<BuilderSkill>) => void;
  removeSkill: (index: number) => void;
  addMcp: () => void;
  updateMcp: (index: number, patch: Partial<BuilderMcpServer>) => void;
  removeMcp: (index: number) => void;
  load: (draft: BuilderDraft) => void;
}

/**
 * React binding around `builderReducer`. Holds the draft, and derives the live
 * validation problems + serialized `harness.json`/`policy.json` on every edit —
 * so a form view can render the outputs and the problem list without any JSON.
 */
export function useBuilder(initial: BuilderDraft = emptyDraft): UseBuilder {
  const [draft, dispatch] = useReducer(builderReducer, initial);
  const problems = useMemo(() => validateDraft(draft), [draft]);
  const manifest = useMemo(() => draftToManifest(draft), [draft]);
  const policy = useMemo(() => draftToPolicy(draft), [draft]);
  return {
    draft,
    problems,
    valid: problems.length === 0,
    manifest,
    policy,
    setField: useCallback((field, value) => dispatch({ type: "setField", field, value }), []),
    addRule: useCallback(() => dispatch({ type: "addRule" }), []),
    updateRule: useCallback((index, patch) => dispatch({ type: "updateRule", index, patch }), []),
    removeRule: useCallback((index) => dispatch({ type: "removeRule", index }), []),
    addSkill: useCallback(() => dispatch({ type: "addSkill" }), []),
    updateSkill: useCallback((index, patch) => dispatch({ type: "updateSkill", index, patch }), []),
    removeSkill: useCallback((index) => dispatch({ type: "removeSkill", index }), []),
    addMcp: useCallback(() => dispatch({ type: "addMcp" }), []),
    updateMcp: useCallback((index, patch) => dispatch({ type: "updateMcp", index, patch }), []),
    removeMcp: useCallback((index) => dispatch({ type: "removeMcp", index }), []),
    load: useCallback((d) => dispatch({ type: "load", draft: d }), []),
  };
}
