# harnesses/acme-fintech

"Acme Engineer" — a platform-engineering assistant for an ~80-person fintech.

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
