import { useEffect, useRef, useState } from "react";
import { draftFromManifest, draftToSkillContents, useBuilder, type PolicyAction } from "./builder.ts";
import type { LoadedDefinition, SaveResult } from "./chat.ts";

/**
 * Visual harness builder — author `harness.json` + `policy.json` from a form,
 * with the serialized files and validation shown live, no hand-editing JSON. The
 * authoritative gate remains `openharness doctor` on the saved files; this panel
 * gives immediate, cheap feedback while shaping a definition.
 */
const ACTIONS: PolicyAction[] = ["allow", "deny", "ask"];

export interface BuilderPanelProps {
  onClose?: () => void;
  /** Persist the current draft (sends it to the sidecar). Absent → no save affordance. */
  onSave?: (input: {
    name: string;
    manifest: unknown;
    policy: unknown;
    systemPrompt: string;
    skills: { path: string; content: string }[];
  }) => void;
  /** Whether saving is currently possible (connected to the sidecar). */
  canSave?: boolean;
  /** The last save outcome to surface (from the sidecar's `definition_saved`). */
  saveResult?: SaveResult;
  /** Request the list of saved definitions (populates `availableDefinitions`). Absent → no load affordance. */
  onListDefinitions?: () => void;
  /** Load a saved definition for editing. */
  onLoadDefinition?: (name: string) => void;
  availableDefinitions?: string[];
  /** A definition loaded for editing — folded into the draft when it arrives. */
  loadedDefinition?: LoadedDefinition;
  /** Called once the loaded definition has been folded into the draft, so the
   *  parent can clear it (one-shot) and a later remount starts with a blank draft. */
  onLoadedApplied?: () => void;
}

export function BuilderPanel({
  onClose,
  onSave,
  canSave,
  saveResult,
  onListDefinitions,
  onLoadDefinition,
  availableDefinitions,
  loadedDefinition,
  onLoadedApplied,
}: BuilderPanelProps) {
  const b = useBuilder();

  // A save/verify verdict is only valid for the draft it was computed on. Snapshot
  // the draft when a verdict arrives; once the draft changes, the verdict is stale
  // and must not keep implying an edited/unsaved draft is "doctor OK".
  const [savedSnapshot, setSavedSnapshot] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (saveResult !== undefined) setSavedSnapshot(JSON.stringify(b.draft));
    // Keyed on saveResult only — we deliberately capture the draft AS SAVED.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveResult]);
  const verdictFresh = saveResult !== undefined && savedSnapshot === JSON.stringify(b.draft);

  // Ask for the saved-definition list once, when a load affordance is wired.
  useEffect(() => {
    onListDefinitions?.();
  }, [onListDefinitions]);

  // When a definition is loaded from disk, fold its raw files into the draft
  // (round-trip-safe: draftFromManifest carries the gateway pin, version, extra
  // providers, etc.). Guard on identity so we apply each load exactly once.
  const appliedRef = useRef<LoadedDefinition | undefined>(undefined);
  useEffect(() => {
    if (loadedDefinition && loadedDefinition !== appliedRef.current) {
      appliedRef.current = loadedDefinition;
      b.load(
        draftFromManifest(
          loadedDefinition.manifest,
          loadedDefinition.policy,
          loadedDefinition.systemPrompt,
          loadedDefinition.skills,
        ),
      );
      // Consume it (one-shot): if we don't, a remount (back to chat, then "build a
      // harness again") re-applies this now-stale definition over the fresh draft.
      onLoadedApplied?.();
    }
  }, [loadedDefinition, b, onLoadedApplied]);

  return (
    <div className="builder" role="region" aria-label="Harness builder">
      <header className="builder-head">
        <h1>Build a harness</h1>
        <div className="builder-head-right">
          {onLoadDefinition && availableDefinitions && availableDefinitions.length > 0 ? (
            <label className="builder-load">
              <span className="builder-load-label">Open</span>
              <select
                aria-label="Open a saved definition"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) onLoadDefinition(e.target.value);
                }}
              >
                <option value="" disabled>
                  saved definition…
                </option>
                {availableDefinitions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {onClose ? (
            <button type="button" className="builder-back" onClick={onClose}>
              Back to chat
            </button>
          ) : null}
        </div>
      </header>

      <div className="builder-grid">
        <form className="builder-form" aria-label="Definition fields">
          <label className="builder-field">
            <span>Name (slug)</span>
            <input
              aria-label="Name"
              value={b.draft.name}
              onChange={(e) => b.setField("name", e.target.value)}
              placeholder="acme-assistant"
            />
          </label>
          <label className="builder-field">
            <span>Display name</span>
            <input
              aria-label="Display name"
              value={b.draft.displayName}
              onChange={(e) => b.setField("displayName", e.target.value)}
              placeholder="Acme Assistant"
            />
          </label>
          <label className="builder-field">
            <span>Accent</span>
            <input
              aria-label="Accent"
              value={b.draft.accent}
              onChange={(e) => b.setField("accent", e.target.value)}
              placeholder="#4F46E5"
            />
          </label>
          <label className="builder-field builder-field-wide">
            <span>System prompt</span>
            <textarea
              aria-label="System prompt"
              rows={4}
              value={b.draft.systemPrompt}
              onChange={(e) => b.setField("systemPrompt", e.target.value)}
              placeholder="You are Acme's governed assistant…"
            />
          </label>
          <label className="builder-field">
            <span>Provider</span>
            <input aria-label="Provider" value={b.draft.provider} onChange={(e) => b.setField("provider", e.target.value)} />
          </label>
          <label className="builder-field">
            <span>Model</span>
            <input aria-label="Model" value={b.draft.model} onChange={(e) => b.setField("model", e.target.value)} />
          </label>
          <label className="builder-field">
            <span>Credential profile</span>
            <input
              aria-label="Credential profile"
              value={b.draft.credentialProfile}
              onChange={(e) => b.setField("credentialProfile", e.target.value)}
            />
          </label>
          <label className="builder-field">
            <span>Policy default</span>
            <select
              aria-label="Policy default"
              value={b.draft.policyDefault}
              onChange={(e) => b.setField("policyDefault", e.target.value)}
            >
              <option value="deny">deny (recommended)</option>
              <option value="allow">allow</option>
            </select>
          </label>

          <fieldset className="builder-rules">
            <legend>Policy rules</legend>
            {b.draft.rules.map((rule, i) => (
              <div className="builder-rule" key={i}>
                <input
                  aria-label={`Rule ${i + 1} match`}
                  value={rule.match}
                  onChange={(e) => b.updateRule(i, { match: e.target.value })}
                  placeholder="mcp__github__* or bash(*rm*)"
                />
                <select
                  aria-label={`Rule ${i + 1} action`}
                  value={rule.action}
                  onChange={(e) => b.updateRule(i, { action: e.target.value as PolicyAction })}
                >
                  {ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <button type="button" aria-label={`Remove rule ${i + 1}`} onClick={() => b.removeRule(i)}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="builder-add-rule" onClick={() => b.addRule()}>
              + Add rule
            </button>
          </fieldset>

          <fieldset className="builder-rules">
            <legend>Skills</legend>
            {b.draft.skills.map((skill, i) => (
              <div className="builder-mcp" key={i}>
                <div className="builder-rule">
                  <input
                    aria-label={`Skill ${i + 1} path`}
                    value={skill.path}
                    onChange={(e) => b.updateSkill(i, { path: e.target.value })}
                    placeholder="skills/triage"
                  />
                  <label className="builder-check">
                    <input
                      type="checkbox"
                      aria-label={`Skill ${i + 1} mandatory`}
                      checked={skill.mandatory}
                      onChange={(e) => b.updateSkill(i, { mandatory: e.target.checked })}
                    />
                    mandatory
                  </label>
                  <button type="button" aria-label={`Remove skill ${i + 1}`} onClick={() => b.removeSkill(i)}>
                    ✕
                  </button>
                </div>
                <textarea
                  aria-label={`Skill ${i + 1} content`}
                  rows={4}
                  value={skill.content}
                  onChange={(e) => b.updateSkill(i, { content: e.target.value })}
                  placeholder={"---\nname: triage\ndescription: When to triage…\n---\n\n# Triage\n\nSteps the agent follows."}
                />
              </div>
            ))}
            <button type="button" className="builder-add-rule" onClick={() => b.addSkill()}>
              + Add skill
            </button>
          </fieldset>

          <fieldset className="builder-rules">
            <legend>MCP servers</legend>
            {b.draft.mcpServers.map((srv, i) => (
              <div className="builder-mcp" key={i}>
                <div className="builder-rule">
                  <input
                    aria-label={`MCP ${i + 1} name`}
                    value={srv.name}
                    onChange={(e) => b.updateMcp(i, { name: e.target.value })}
                    placeholder="github"
                  />
                  <select
                    aria-label={`MCP ${i + 1} transport`}
                    value={srv.transport}
                    onChange={(e) => b.updateMcp(i, { transport: e.target.value as "stdio" | "http" })}
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                  </select>
                  <button type="button" aria-label={`Remove MCP server ${i + 1}`} onClick={() => b.removeMcp(i)}>
                    ✕
                  </button>
                </div>
                {srv.transport === "stdio" ? (
                  <input
                    aria-label={`MCP ${i + 1} command`}
                    value={srv.command}
                    onChange={(e) => b.updateMcp(i, { command: e.target.value })}
                    placeholder="npx -y @scope/server@1.2.3 (pin the version)"
                  />
                ) : (
                  <input
                    aria-label={`MCP ${i + 1} url`}
                    value={srv.url}
                    onChange={(e) => b.updateMcp(i, { url: e.target.value })}
                    placeholder="https://mcp.acme.internal"
                  />
                )}
                <input
                  aria-label={`MCP ${i + 1} tools`}
                  value={srv.tools}
                  onChange={(e) => b.updateMcp(i, { tools: e.target.value })}
                  placeholder="tool allowlist, comma-separated (empty = all)"
                />
              </div>
            ))}
            <button type="button" className="builder-add-rule" onClick={() => b.addMcp()}>
              + Add MCP server
            </button>
          </fieldset>
        </form>

        <aside className="builder-output" aria-label="Generated files">
          <div className={`builder-status builder-status-${b.valid ? "ok" : "bad"}`}>
            {b.valid ? "Valid — ready to save & run doctor" : `${b.problems.length} issue(s) to fix`}
          </div>
          {b.problems.length > 0 ? (
            <ul className="builder-problems" aria-label="Validation problems">
              {b.problems.map((p, i) => (
                <li key={i}>{p.field ? `${p.field}: ${p.message}` : p.message}</li>
              ))}
            </ul>
          ) : null}
          <h2>harness.json</h2>
          <pre className="builder-pre" aria-label="harness.json preview">
            {JSON.stringify(b.manifest, null, 2)}
          </pre>
          <h2>policy.json</h2>
          <pre className="builder-pre" aria-label="policy.json preview">
            {JSON.stringify(b.policy, null, 2)}
          </pre>
          <p className="builder-note">
            System prompt is written to <code>system-prompt.md</code>. Save these files to a directory, then run{" "}
            <code>openharness doctor &lt;dir&gt;</code> to verify before building.
          </p>
          {onSave ? (
            <div className="builder-save">
              <button
                type="button"
                className="builder-save-btn"
                disabled={!b.valid || !canSave}
                onClick={() =>
                  onSave({
                    name: b.draft.name,
                    manifest: b.manifest,
                    policy: b.policy,
                    systemPrompt: b.draft.systemPrompt,
                    skills: draftToSkillContents(b.draft),
                  })
                }
              >
                {canSave ? "Save & verify" : "Connecting…"}
              </button>
              {saveResult && verdictFresh ? (
                <p
                  className={`builder-save-result builder-save-result-${saveResult.error ? "bad" : saveResult.ok ? "ok" : "warn"}`}
                  role="status"
                >
                  {saveResult.error
                    ? `Couldn't save: ${saveResult.error}`
                    : saveResult.ok
                      ? `Saved to ${saveResult.dir} — doctor OK${saveResult.problems.length ? ` (${saveResult.problems.length} warning(s))` : ""}.`
                      : `Saved to ${saveResult.dir}, but doctor found ${saveResult.problems.filter((p) => p.level === "error").length} error(s) — fix before building.`}
                </p>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
