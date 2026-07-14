# Authoring a Harness

A **HarnessDefinition** is a directory. This is everything it can contain and how
to ship it. Working examples: [`harnesses/acme-fintech`](../harnesses/acme-fintech),
[`harnesses/northwind-ops`](../harnesses/northwind-ops),
[`harnesses/meridian-support`](../harnesses/meridian-support) (the non-technical
desktop operator — `bash` denied, ask-on-every-write, heavy PII redaction).

Starting from scratch? `openharness init my-harness` scaffolds a minimal, valid,
offline-safe one for you (no `mcp` section, a permissive-but-documented starter
`policy.json`, one mandatory skill) — see `--help` via the usage line below.

## Layout

```
my-harness/
├─ harness.json            # the manifest (below)
├─ system-prompt.md        # or reference a curated one (see Prompts)
├─ policy.json             # optional — governance rules
├─ skills/<name>/SKILL.md  # optional — Agent-Skills the model can open
├─ prompts/*.md            # optional — a curated prompt library (in-dir so it ships)
└─ branding/icon.png       # optional — 1024px square for `openharness build`
```

> Everything a definition references **must live inside its own directory** —
> `openharness build` refuses out-of-dir paths (they wouldn't ship in the signed
> bundle). Share prompts by copying them in, not with `../`.

## `harness.json`

```jsonc
{
  "name": "acme-fintech",              // [a-z0-9-], the bundle/app name
  "version": "0.1.0",                  // semver — also the anti-rollback floor
  "branding": {
    "displayName": "Acme Engineer",    // window title / product name
    "accent": "#0E7C61",               // hex
    "icon": "branding/icon.png"        // optional
  },

  // A file path, OR a curated-library ref "lib:<name>" (needs promptLibrary):
  "systemPrompt": "lib:platform-eng-base",
  "appendSystemPrompt": "system-prompt-acme.md",   // optional, layered on top
  "promptLibrary": "prompts",                       // dir of curated prompts

  "skills": [{ "path": "skills/incident-triage", "mandatory": true }],

  "providers": {
    "default": {
      "provider": "anthropic",         // Pi provider id
      "model": "claude-sonnet-5",
      "credentialProfile": "work"      // a profile name (see Credentials) — NOT a key
    }
  },

  "mcp": { "servers": { /* see MCP */ } }   // optional
}
```

## `policy.json` (governance)

Deny-by-default, first-match. Enforced in-process at every tool call and model request.

```jsonc
{
  "default": "deny",                    // allow | deny | ask  (omitted → deny)
  "rules": [
    { "match": "read", "action": "allow" },
    { "match": "bash(git *)", "action": "allow" },              // bash: matches the command
    { "match": "mcp__internal_docs__*", "action": "allow" },
    { "match": "mcp__*__delete_*", "action": "deny", "reason": "destructive ops need a human" },
    // argument-matching works for ANY tool: <tool>(<glob>) matches (case-insensitive)
    // a canonical string of ALL the tool's string args (nested included) — fail-safe:
    { "match": "mcp__db__write_query(*DELETE*)", "action": "ask" }
  ],
  "models": { "allow": ["anthropic/claude-*"] },   // deny wins; allow = allow-list
  "redact": [                                        // applied to args AND results
    { "pattern": "AKIA[0-9A-Z]{16}", "replace": "[aws-key]" },
    { "pattern": "Bearer\\s+[A-Za-z0-9._-]+", "replace": "Bearer [redacted]" }
  ]
}
```

- `match` is a glob over the tool identity: a tool name (`mcp__linear__delete_*`),
  or the parameterized `tool(<glob>)` form (`bash(...)` matches the command; any
  other tool matches its canonical arg string).
- `action`: `deny` → blocked (the `reason` is shown to the model); `ask` → a human
  approves/denies in the TUI/desktop (fail-closed if no human); `allow` → runs.
- `redact.pattern` is a JS RegExp source; `g` is always forced.

## MCP servers

```jsonc
"mcp": { "servers": {
  "internal_docs": {
    "transport": "stdio",
    "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/docs"],
    "tools": ["read_file", "list_directory"],   // optional allowlist
    "mandatory": false                            // true → harness fails fast if it can't connect
  },
  "analytics": {
    "transport": "stdio",
    "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://ro@db/analytics"],
    "secrets": { "PGPASSWORD": "acme-analytics-ro" }   // ENV var → credential REF (never a value)
  },
  "backoffice": {
    "transport": "http", "url": "https://mcp.acme.internal",
    "secrets": { "Authorization": "acme-backoffice-token" }   // HEADER → credential REF
  }
}}
```

Each MCP tool becomes `mcp__<server>__<tool>` and is policy-gated like any tool.
**Secrets are referenced by name, never inlined** — the ref is resolved at connect
from the machine-local store, so real credentials never enter `harness.json` or the
signed bundle. (Refs in the reserved `api-key:*` LLM-credential namespace are rejected.)

## Credentials (bring your own key)

`credentialProfile` names a profile; accounts come from:
- **env** — `ANTHROPIC_API_KEY`→anthropic, `OPENAI_API_KEY`→openai,
  `GEMINI_API_KEY`→google, `OPENCODE_GO_API_KEY`→opencode-go.
- **`<configDir>/accounts.json`** — `{ profiles: { <name>: { policy, accounts:[{id, provider, authProviderId, label, apiKey?|apiKeyEnv?, baseUrl?}] } } }`.

Selection is **provider-scoped**: a harness for provider X is only ever handed an
X account (rotating/failing over among them); consumer subscriptions are personal
(never pooled across users). MCP-server secrets live in the same encrypted store.

## Prompts library

Curate reusable system prompts as `.md` files with frontmatter, inside the
definition dir so they ship:

```markdown
---
name: platform-eng-base
description: Careful platform-engineering assistant.
---
You are a platform engineer. Respect production...
```

Reference them: `promptLibrary: "prompts"` + `systemPrompt: "lib:platform-eng-base"`
(+ `appendSystemPrompt` for org specifics). Plain-path system prompts still work.

## Run & ship

```bash
openharness init harnesses/my-harness                  # scaffold a starter definition
npm run chat -- harnesses/my-harness "do the thing"   # live turn (needs a key)
openharness keygen --out org                           # org signing key (once)
openharness build harnesses/my-harness --key org.key --out dist/my --org acme --name eng
cd dist/my && npx tauri build                          # branded, signed installer
openharness serve --bundles dist --audit ./audit       # central bundle host + audit sink
```

The built app boots pinned to the signed definition and refuses a tampered,
unsigned, or rolled-back one. See [`DEMO.md`](DEMO.md) for the full walkthrough.
