# harnesses/acme-fintech

"Acme Engineer" — a platform-engineering assistant for an ~80-person fintech.

- **System prompt is composed from a curated library, not inlined.**
  `promptLibrary: "prompts"` points at this definition's own copy of the org's
  shared, curated prompts (see `harnesses/_prompts/` for the source the org
  maintains); `systemPrompt: "lib:platform-eng-base"` selects the approved base
  prompt by NAME rather than embedding its text, and `appendSystemPrompt:
  "system-prompt-acme.md"` layers Acme-specific detail (identity, "money-moving
  infrastructure" framing, which internal MCP servers to check first) on top.
  The library must live **inside** this definition dir — `bundleDefinition`
  only walks files under the definition root, so a `promptLibrary` pointing
  outside it wouldn't ship in the signed `.ohbundle`. `harnesses/example` and
  `harnesses/northwind-ops` still use a plain-path `systemPrompt` (no library)
  to prove that form keeps working unchanged.
- **Posture:** deny-by-default (`policy.json` `"default": "deny"`). Reads,
  `git` via bash, and the two MCP servers below are explicitly allow-listed;
  everything else — including anything a rule doesn't anticipate — falls
  through to deny. Destructive MCP tool names (`*delete*`, `*drop*`) are
  denied outright regardless of server.
- **MCP servers are illustrative and fully optional.** Both `internal_docs`
  (`@modelcontextprotocol/server-filesystem`) and `analytics_readonly`
  (`@modelcontextprotocol/server-postgres`) are declared with
  `"mandatory": false`, so this harness loads, bundles, and builds offline —
  nothing needs to be running or installed to validate the definition. Point
  them at a real docs root / read-only replica to actually use them.
- **The analytics DB password is never in this repo or the bundle.**
  `analytics_readonly` uses credential indirection: its `secrets` map points the
  `PGPASSWORD` env var at the credential **ref name** `acme-analytics-ro` — a
  name, not a value, exactly like `credentialProfile` for providers. The real
  secret is provisioned **locally** into the machine's secret store (via
  `openharness creds` / the `EncryptedFileSecretStore`) and resolved at
  connect-time; it is merged into the postgres server's child-process env and
  never written to `harness.json` or the signed `.ohbundle`. A ref that the
  local store can't resolve fails the connection (fail-closed) rather than
  connecting with a blank password. (For an http-transport server the same
  `secrets` map keys header names instead of env vars — the http auth path.)
