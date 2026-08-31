# Contributing

Thanks for considering a contribution. A few things to know before you dive in.

## Project scope

This is a focused WhatsApp AI lead-capture and sales bot for a single
business per running instance — not a general-purpose WhatsApp API gateway.
Before proposing a large feature (multi-tenant support, a new messaging
channel, a full REST API), open an issue first to discuss whether it fits
this project's scope or belongs in a fork/separate tool. See
`FULL_LAUNCH_PROMPT.md` for the intended longer-term roadmap.

## Setup for local development

1. Node.js v22.5+ (this project uses Node's built-in `node:sqlite` —
   no native compilation step).
2. `npm install`
3. `cp .env.example .env` and fill in `ENCRYPTION_KEY` / `SESSION_SECRET`
   (see the README's Setup section for the exact commands).
4. `npm run dashboard` and `npm start` in separate terminals.

## Before opening a pull request

- **Syntax-check every file you touched:** `node --check path/to/file.js`
- **Test the actual behavior**, not just that it runs — this project has
  been burned before by AI provider model names going stale silently; if
  you're touching a `providers/*.js` adapter, verify the model/endpoint
  against the provider's current docs, don't assume training data is current.
- **Never commit real API keys, `.env`, or `data.sqlite`** — `.gitignore`
  already excludes these, don't work around it.
- **Keep the safety boundaries intact.** Specifically:
  - The AI must never be treated as the source of truth for whether a
    payment succeeded — that's Stripe's webhook, not AI-generated text.
  - The AI must never quote or sell a price/item that isn't in the
    business's own price list.
  - Escalation keywords must always take priority over a normal AI reply.
  
  If your change touches any of this logic, explain in the PR description
  exactly how you preserved these guarantees.

## Code style

- Plain JavaScript (ES modules), no build step, no TypeScript, no
  framework beyond Express — keep it that way. This project's entire
  value proposition is "not a big application to maintain."
- Comment *why*, not *what*, especially around anything security- or
  money-related.

## Reporting security issues

If you find a real security vulnerability (not just a bug), please don't
open a public issue — email the maintainer directly (see repository
settings) so it can be fixed before it's public.
