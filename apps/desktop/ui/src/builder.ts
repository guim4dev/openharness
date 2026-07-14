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

export interface BuilderRule {
  match: string;
  action: PolicyAction;
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
  | { type: "load"; draft: BuilderDraft };

export function builderReducer(draft: BuilderDraft, action: BuilderAction): BuilderDraft {
  switch (action.type) {
    case "setField":
      return { ...draft, [action.field]: action.value };
    case "addRule":
      return { ...draft, rules: [...draft.rules, { match: "", action: "deny" }] };
    case "updateRule":
      return {
        ...draft,
        rules: draft.rules.map((r, i) => (i === action.index ? { ...r, ...action.patch } : r)),
      };
    case "removeRule":
      return { ...draft, rules: draft.rules.filter((_, i) => i !== action.index) };
    case "load":
      return { ...action.draft };
    default:
      return draft;
  }
}

/** The `harness.json` object for a draft (systemPrompt lives in a sibling file). */
export function draftToManifest(draft: BuilderDraft): Record<string, unknown> {
  return {
    name: draft.name,
    version: "0.1.0",
    branding: { displayName: draft.displayName, accent: draft.accent },
    systemPrompt: "system-prompt.md",
    skills: [],
    providers: {
      default: { provider: draft.provider, model: draft.model, credentialProfile: draft.credentialProfile },
    },
  };
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
  const req = (v: string, field: BuilderScalarField, label: string) => {
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
    load: useCallback((d) => dispatch({ type: "load", draft: d }), []),
  };
}
