# harnesses/meridian-support

"Meridian Support Desk" — a customer-facing support assistant for a
**non-technical** representative working entirely in the desktop window. This
is the example that exercises the "everyone else" frontend and the desktop
approval modal.

- **Posture:** ask-by-default (`policy.json` `"default": "ask"`), and `bash`
  is **explicitly denied** — this operator has no terminal and never runs
  shell. Reads (`read`, `search_kb`, `get_customer`, `get_ticket`,
  `list_tickets`) are allow-listed; every outbound action
  (`reply_to_customer`, `create_ticket`, `update_ticket`, `issue_credit`) is
  `"ask"`, so the representative confirms each one before it reaches a customer
  or moves money. Anything unlisted also falls through to "ask", never a silent
  allow.
- **Heavy PII redaction.** Email, credit-card-shaped, government-ID-shaped, and
  phone patterns are redacted in both tool arguments and results, so a
  customer's personal data never lands verbatim in the model's context or the
  audit log. (Heuristic patterns — a backstop for the operator's judgment, not
  a compliance guarantee.)
- **MCP server is illustrative and fully optional.** `helpdesk`
  (`"mandatory": false`) is a placeholder for your own helpdesk/CRM MCP server,
  so this harness loads, bundles, and builds offline — nothing needs to be
  running to validate the definition. Point it at your real server to use it.
- **Run it in the GUI.** Because every write is `"ask"`, this is the example to
  open with `npm run dev:desktop` to see the approve/deny modal fire on real
  actions.
