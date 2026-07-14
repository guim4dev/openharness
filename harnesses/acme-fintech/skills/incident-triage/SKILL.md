---
name: incident-triage
description: Triage a production incident or alert for Acme's platform — assess blast radius, check recent changes, and recommend the safest next action.
---

Use when asked to triage an incident, an alert, or "something's on fire".

1. **Scope it.** Which service, which environment (staging vs prod), and
   what's the actual customer/money impact right now — not the theoretical
   worst case.
2. **Check recent changes first.** Look at the last few deploys or config
   changes to the affected service via `internal_docs` before touching
   anything — most incidents trace back to something that changed recently.
3. **Prefer read-only diagnostics.** Logs, the `analytics_readonly` server,
   and docs search come before any mutating action.
4. **Never self-serve a destructive fix.** If the remediation is a
   production write, a rollback, or anything irreversible, say exactly what
   you'd run and why, then wait for a human to confirm it.
5. **Close with a clear summary:** what's confirmed, what's still unknown,
   and the single safest next step — not a list of everything that could be
   wrong.
