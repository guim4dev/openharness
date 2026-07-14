import { useBuilder, type PolicyAction } from "./builder.ts";

/**
 * Visual harness builder — author `harness.json` + `policy.json` from a form,
 * with the serialized files and validation shown live, no hand-editing JSON. The
 * authoritative gate remains `openharness doctor` on the saved files; this panel
 * gives immediate, cheap feedback while shaping a definition.
 */
const ACTIONS: PolicyAction[] = ["allow", "deny", "ask"];

export function BuilderPanel({ onClose }: { onClose?: () => void }) {
  const b = useBuilder();

  return (
    <div className="builder" role="region" aria-label="Harness builder">
      <header className="builder-head">
        <h1>Build a harness</h1>
        {onClose ? (
          <button type="button" className="builder-back" onClick={onClose}>
            Back to chat
          </button>
        ) : null}
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
        </aside>
      </div>
    </div>
  );
}
