import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export class ScaffoldError extends Error {}

export interface ScaffoldHarnessOptions {
  /** Manifest `name` (also the bundle/app name). Defaults to the target dir's basename. */
  name?: string;
  /** `branding.displayName`. Defaults to a title-cased form of `name`. */
  displayName?: string;
  /** `providers.default.provider`. Defaults to "anthropic". */
  provider?: string;
  /** `providers.default.model`. Defaults to "claude-sonnet-5". */
  model?: string;
}

export interface ScaffoldHarnessResult {
  /** The resolved, absolute directory the harness was written into. */
  rootDir: string;
  /** The manifest `name` that was written. */
  name: string;
}

/** True when `dir` does not exist yet, or exists but has no entries. */
async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}

/** "my-cool_harness" -> "My Cool Harness". Used only as a sensible displayName default. */
function titleCase(name: string): string {
  const words = name.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function readmeTemplate(name: string, displayName: string): string {
  return `# ${name}

"${displayName}" — a harness scaffolded by \`openharness init\`. Fill in the
pieces below to make it yours, then ship it.

## What this is

A minimal, valid, **offline-safe** \`HarnessDefinition\`:

- \`harness.json\` — the manifest (branding, system prompt, one mandatory skill,
  default provider). No \`mcp\` section, so this loads/builds/runs with nothing
  else running — see the commented example below to add one.
- \`system-prompt.md\` — the starter system prompt. Edit it first.
- \`policy.json\` — a **permissive-but-documented** starter policy: default
  \`"allow"\`, a couple of illustrative allow/deny rules, and one \`redact\` rule
  for a generic \`sk-...\`-shaped secret. This was chosen (over a stricter
  default \`"ask"\`) so the scaffold runs immediately without a human in the
  loop for every tool call — tighten it to \`"deny"\`-by-default before this
  harness ever touches anything real. See \`docs/AUTHORING.md\` for the full
  policy language.
- \`skills/getting-started/SKILL.md\` — a starter Agent Skill. Replace it (and
  add more skill dirs) with real task guidance.

## Chat with it

Bring your own key (any one of \`ANTHROPIC_API_KEY\` / \`OPENAI_API_KEY\` /
\`GEMINI_API_KEY\` / \`OPENCODE_GO_API_KEY\`, matching the provider below), then
from the repo root:

\`\`\`bash
npm run chat -- ${name} "Say hello in one line."
\`\`\`

## Build a signed, branded app

\`\`\`bash
openharness keygen --out org                              # once, keep org.key private
openharness build ${name} --key org.key --out dist/${name} --org acme --name ${name}
cd dist/${name} && npx tauri build                         # -> a branded installer
\`\`\`

## Cheatsheet: adding MCP servers (optional)

Not wired by default — add a \`mcp\` block to \`harness.json\` to bridge in real
tools. Full reference: \`docs/AUTHORING.md\`.

\`\`\`jsonc
// "mcp": { "servers": {
//   "internal_docs": {
//     "transport": "stdio",
//     "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/docs"],
//     "tools": ["read_file", "list_directory"],   // optional allowlist
//     "mandatory": false                            // true -> harness fails fast if it can't connect
//   },
//   "backoffice": {
//     "transport": "http", "url": "https://mcp.example.internal",
//     "secrets": { "Authorization": "example-backoffice-token" }   // HEADER -> credential REF, never a value
//   }
// } }
\`\`\`

Each MCP tool becomes \`mcp__<server>__<tool>\` and is policy-gated like any
other tool call.

## Cheatsheet: policy.json

\`\`\`jsonc
// {
//   "default": "deny",                              // allow | deny | ask (omitted -> deny)
//   "rules": [
//     { "match": "read", "action": "allow" },
//     { "match": "bash(git *)", "action": "allow" },
//     { "match": "mcp__*__delete_*", "action": "deny", "reason": "destructive ops need a human" },
//     // argument-matching for ANY tool: <tool>(<glob>) matches a canonical string of its args
//     { "match": "mcp__db__write_query(*DELETE*)", "action": "ask" }
//   ],
//   "models": { "allow": ["anthropic/claude-*"] },   // deny wins; allow = allow-list
//   "redact": [
//     { "pattern": "AKIA[0-9A-Z]{16}", "replace": "[aws-key]" }
//   ]
// }
\`\`\`

Deny-by-default, first-match, enforced in-process at every tool call and model
request. Full reference (including credential indirection and MCP secrets):
[\`docs/AUTHORING.md\`](../../docs/AUTHORING.md).
`;
}

/**
 * Scaffold a minimal, valid, offline-safe `HarnessDefinition` into `dir`:
 * `harness.json` (no `mcp` section — stays trivially runnable), `system-prompt.md`,
 * a permissive-but-documented starter `policy.json`, one mandatory
 * `skills/getting-started/SKILL.md`, and a `README.md`.
 *
 * FAIL-SAFE: refuses to write into an existing, non-empty `dir` (never
 * overwrites). Creates parent dirs as needed.
 */
export async function scaffoldHarness(
  dir: string,
  opts: ScaffoldHarnessOptions = {},
): Promise<ScaffoldHarnessResult> {
  const root = resolve(dir);

  if (!(await isEmptyOrMissing(root))) {
    throw new ScaffoldError(
      `openharness init: '${root}' already exists and is not empty. Refusing to overwrite an existing harness — pick an empty or new directory.`,
    );
  }

  const name = opts.name ?? basename(root);
  const displayName = opts.displayName ?? titleCase(name);
  const provider = opts.provider ?? "anthropic";
  const model = opts.model ?? "claude-sonnet-5";

  await mkdir(join(root, "skills", "getting-started"), { recursive: true });

  const manifest = {
    name,
    version: "0.1.0",
    branding: { displayName },
    systemPrompt: "system-prompt.md",
    skills: [{ path: "skills/getting-started", mandatory: true }],
    providers: { default: { provider, model, credentialProfile: "work" } },
  };
  await writeFile(join(root, "harness.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  await writeFile(
    join(root, "system-prompt.md"),
    `You are ${displayName}, a helpful assistant built with OpenHarness.\n\n` +
      "Be concise and direct: say what you did, not what you're about to do. " +
      "Ask before taking any destructive or irreversible action, and say so " +
      "plainly when you're unsure rather than guessing.\n",
  );

  // Permissive-but-documented starter (see README.md for the rationale): default
  // "allow" so the scaffold runs immediately with no human in the loop, a couple
  // of illustrative rules showing both allow and deny, and one redact rule for a
  // generic `sk-...`-shaped secret. Tighten to a "deny" default before this
  // harness touches anything real — see docs/AUTHORING.md.
  const policy = {
    default: "allow",
    rules: [
      { match: "read", action: "allow", reason: "Reading files is always safe." },
      // MCP egress governance (secure-by-default): MCP tools reach external
      // systems, so mutations are governed up front — destructive ops are denied
      // and other writes require a human. These are inert until you add a `mcp`
      // block to harness.json, then they govern every bridged mcp__<server>__*
      // tool. Scope them to real server/tool names as you wire servers in.
      {
        match: "mcp__*__delete_*",
        action: "deny",
        reason: "Destructive MCP operations are blocked by the starter policy.",
      },
      {
        match: "mcp__*__create_*",
        action: "ask",
        reason: "Creating via an MCP tool reaches an external system — approve until scoped.",
      },
      {
        match: "mcp__*__update_*",
        action: "ask",
        reason: "Updating via an MCP tool reaches an external system — approve until scoped.",
      },
      {
        match: "mcp__*__send_*",
        action: "ask",
        reason: "Sending via an MCP tool reaches an external system — approve until scoped.",
      },
      {
        match: "bash(rm -rf *)",
        action: "deny",
        reason: "Recursive force-delete is blocked by the starter policy.",
      },
    ],
    redact: [{ pattern: "sk-[A-Za-z0-9_-]{16,}", replace: "sk-REDACTED" }],
  };
  await writeFile(join(root, "policy.json"), `${JSON.stringify(policy, null, 2)}\n`);

  await writeFile(
    join(root, "skills", "getting-started", "SKILL.md"),
    "---\n" +
      "name: getting-started\n" +
      "description: Starting point for this harness — replace with real task guidance.\n" +
      "---\n" +
      "This is a starter skill scaffolded by `openharness init`. Replace its content " +
      "with instructions for a real task this harness should handle, and add more " +
      "skills alongside it as `skills/<name>/SKILL.md`.\n",
  );

  await writeFile(join(root, "README.md"), readmeTemplate(name, displayName));

  return { rootDir: root, name };
}
