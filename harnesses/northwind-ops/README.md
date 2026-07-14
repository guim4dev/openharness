# harnesses/northwind-ops

"Northwind Ops Copilot" — a back-office / customer-support assistant for
Northwind's ops team.

- **Posture:** ask-by-default for anything mutating (`policy.json`
  `"default": "ask"`). Reads (`read`, `read_query`, `list_tables`,
  `describe_table`) are explicitly allow-listed; the two write-shaped
  back-office tools (`write_query`, `append_insight`) are explicitly marked
  `"ask"` for clarity, though the default already covers them — anything not
  listed here also falls through to "ask", never a silent allow.
- **MCP server is illustrative and fully optional.** `back_office`
  (`@modelcontextprotocol/server-sqlite`) is declared with
  `"mandatory": false`, so this harness loads, bundles, and builds offline —
  nothing needs to be running or installed to validate the definition. Point
  it at a real ops DB to actually use it.
