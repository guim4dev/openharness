---
name: triage
description: Triage a GitHub issue against the team's runbooks and summarize next steps.
---

# Issue triage

When asked to triage an issue:

1. Read the issue list through the governed gateway (`github__list_issues`) — this
   runs server-side; you never see a GitHub token.
2. Cross-reference the relevant runbook under `docs` (`read_file` /
   `list_directory`).
3. Summarize: what the issue is, which runbook applies, and the concrete next
   step. Keep it to a few lines.

If a step is denied by policy, name the denial and stop — do not attempt an
ungoverned path.
