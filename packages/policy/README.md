# @openharness/policy

A pure, dependency-light policy engine: deny-by-default first-match tool-call rules, secret redaction, and model allow/deny gating.

Stateless and I/O-free — it parses a `policy.json` shape and renders decisions in memory. `@openharness/definition` parses harness policies with it; `@openharness/core` enforces the results in-process at Pi's tool-call and provider-request hooks.

## API

- `parsePolicy(raw) -> Policy` / `policySchema` — validate an unknown value into a `Policy` (throws `PolicyError`); `default` is fail-closed (`deny`).
- `decideTool(policy, toolName, args) -> { decision, reason? }` — first-match-wins decision; unmatched falls through to `policy.default`.
- `evaluateTool(policy, toolName, args) -> ToolEvaluation` — the decision plus a redacted deep copy of the args.
- `matchToolIdentity(pattern, toolName, args) -> boolean` — glob a rule's `match` against a tool call (plain name or `name(<glob>)` arg form).
- `checkModel(policy, provider, model) -> "allow" | "deny"` — gate a model (`deny` wins; a non-empty `allow` acts as an allow-list).
- `redact(policy, value)` / `compileRedactors(policy)` + `applyRedactors(redactors, value)` — secret redaction returning a deep copy (never mutates input).
- `globToRegExp(glob, caseInsensitive?)`, `globMatch(glob, value, caseInsensitive?)` — the glob primitives.
- Types: `Policy`, `PolicyAction`, `PolicyRule`, `PolicyModels`, `RedactRule`, `ToolEvaluation`, `CompiledRedactor`.

## Usage

```ts
import { parsePolicy, evaluateTool } from "@openharness/policy";

const policy = parsePolicy({
  default: "ask",
  rules: [{ match: "read", action: "allow" }],
  redact: [{ pattern: "sk-[A-Za-z0-9]{16,}", replace: "[redacted]" }],
});

const { decision, redactedArgs } = evaluateTool(policy, "read", { path: "/etc/app.conf" });
if (decision === "allow") console.log(redactedArgs);
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.
