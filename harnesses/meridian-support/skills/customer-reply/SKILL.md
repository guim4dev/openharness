---
name: customer-reply
description: Draft and send a grounded, confirmed reply to a customer support request.
---

Use when asked to answer a customer, resolve a ticket, or decide on a credit
or refund.

1. **Ground it.** Pull the customer (`get_customer`), their ticket history
   (`get_ticket` / `list_tickets`), and any relevant policy from the knowledge
   base (`search_kb`) before drafting.
2. **Draft in plain language.** Write the reply the representative would send,
   in the customer's own language, without internal jargon or ticket IDs.
3. **Confirm before it goes out.** Sending (`reply_to_customer`), opening or
   changing a ticket (`create_ticket` / `update_ticket`), and issuing credit
   (`issue_credit`) each pause for the representative's confirmation. State
   exactly what will be sent or changed — and for a credit, the amount and the
   customer — before running it.
4. **Never paste raw PII.** Summarize contact details; never repeat a full card
   number or government ID back. The redaction layer is a backstop, not a
   substitute for judgment.
5. **Hand off when unsure.** If policy is ambiguous or the account doesn't add
   up, say so and escalate rather than guessing.
