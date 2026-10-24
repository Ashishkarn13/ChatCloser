# WhatsApp

ChatCloser talks to WhatsApp through **Baileys**, a library that drives a real
WhatsApp Web session. It is not Meta's official Cloud API.

> **This matters.** Automating a WhatsApp account with an unofficial client
> violates WhatsApp's Terms of Service, and numbers have been banned for it.
> Use a spare number until you have migrated to the official API. Do not put a
> business's only number on this channel.

The Cloud API is a deliberate non-goal for this release; the assistant, the
tools and the database do not depend on the transport, so a Cloud API adapter
replaces `index.js` without touching anything else.

---

## Linking a number

1. Open **Integrations → WhatsApp** and press *Connect*.
2. A QR code appears (the console refreshes it automatically).
3. On the phone: WhatsApp → Settings → Linked devices → Link a device → scan.
4. The status becomes `connected` and the console shows the account's display
   name.

The session is stored in `data/auth_info/`. Back it up with the rest of the
data folder: without it, a restore needs a fresh QR scan.

To unlink: *Disconnect* in the console, or WhatsApp → Linked devices → log out.
ChatCloser notices the logout and does not try to reconnect with dead
credentials.

---

## Behaviour at a glance

- **One thread per chat.** Messages are stored with the chat id; a customer's
  thread survives restarts.
- **Human takeover.** Press *Take over* on a thread and the assistant stops
  replying to that chat until you press *Resume*. Every handoff is audited and
  raises a notification.
- **Escalation.** Asking for a human, a complaint, a refund demand, a legal
  threat, a safety issue or a mention of a manager all escalate immediately with
  your configured message.
- **Business hours.** Outside your configured hours the away message is sent
  once per conversation, and the conversation is still captured for follow-up.
- **Rate limits.** `RATE_LIMIT_PER_CHAT_PER_MIN` (default 6) and
  `RATE_LIMIT_GLOBAL_PER_MIN` (default 30) protect against loops and abuse. When
  a limit trips, the message is stored and the assistant stays quiet.
- **Nudges.** `NUDGE_AFTER_HOURS` (default 24) sends one follow-up to a
  conversation that went quiet after an unanswered question; `0` disables it.
- **Media.** Images and documents are recorded as an attachment reference and
  the conversation is flagged for a human; they are not sent to the model.
- **Groups.** Ignored by default.
- **Reconnects.** Exponential backoff, capped, with the status exposed on
  `/health`. A logout stops the retries.

---

## Prompts that keep it honest

The system prompt contains hard rules that the reply validator also enforces
independently:

- Answer only from the knowledge base and catalogue.
- Never state a price that is not in the catalogue.
- Never confirm an order without the customer's explicit confirmation.
- Never claim a payment succeeded.
- Keep replies short; this is chat, not email.
- Hand over anything about safety, disputes, refunds or the law.

Three example knowledge-base entries that carry most of the weight:

```
site_visit: Free site visit within 2-3 working days. Ask for the area and a
  preferred day before promising a time.
timelines: Kitchen remodel 2-4 weeks, full renovation 2-6 months. Estimates
  only; confirm after a site visit.
payment_terms: 30% deposit, 40% at midpoint, 30% on completion. eSewa, Khalti,
  bank transfer.
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| QR appears, then the status drops back to `waiting_for_qr` | Scan timed out or was cancelled | Scan within the displayed window; the code refreshes |
| `disconnected` and reconnecting forever | Network egress blocked, or the linked device was removed on the phone | Check `/health`, re-link |
| Messages arrive in the console but get no reply | No AI provider configured, or the thread is taken over, or rate limited | Check AI Configuration and the thread's state |
| Replies stop for one customer only | Thread is in human takeover, or escalated | *Resume* on the thread |
| `logged out` | Device removed from the phone | Re-link; the old session is discarded |
| Session lost after moving computers | `auth_info/` was not copied | Re-link on the new machine |

Logs from the connection layer are suppressed (`pino` at `silent`) because
Baileys is extremely chatty. Connection state changes are logged by ChatCloser
itself.
