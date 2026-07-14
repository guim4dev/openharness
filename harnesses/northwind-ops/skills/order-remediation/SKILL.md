---
name: order-remediation
description: Diagnose and remediate a stuck, failed, or disputed customer order in the back office.
---

Use when asked to look into an order, a refund request, or a stuck shipment.

1. **Look up before you touch.** Pull the order's current state with
   `read_query` / `list_tables` / `describe_table` before proposing any
   change.
2. **Find the actual failure point.** Payment authorization, an inventory
   hold, a shipping exception, or a customer-initiated dispute each need a
   different fix — don't guess, confirm which one it is.
3. **Ask before any write.** Any state-changing action (refund, cancellation,
   reship, manual status override) goes through `write_query`. State plainly
   what the write will do before running it, and wait for the support lead's
   go-ahead.
4. **Don't quote PII back verbatim.** Summarize instead of pasting full card
   numbers, emails, or phone numbers into a note — the harness redacts common
   patterns, but don't rely on that as the only safeguard.
5. **Log a short, factual note** with `append_insight` so the next agent or
   human has context on what was found and what was done.
