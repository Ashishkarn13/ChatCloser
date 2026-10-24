# Limitations

Everything here is a real limitation of the current release, not a roadmap
promise. Read it before pointing the assistant at paying customers.

---

## Channel

- **Baileys is unofficial.** It drives WhatsApp Web the way a browser does.
  This breaks WhatsApp's Terms of Service and numbers have been banned. Use a
  spare number. There is no Meta Cloud API adapter yet; the transport is
  isolated so one can be added without touching the assistant.
- **One WhatsApp account per installation.** Linking a second number replaces
  the first.
- **No groups, no channels**, no broadcast lists.
- **No email, SMS, Messenger or Instagram.** WhatsApp only.
- Media (images, voice notes, documents) is recorded as a reference and handed
  to a human. It is not transcribed, not analysed and not replied to.
- Voice notes from customers therefore get no automatic answer.

## AI

- The assistant **cannot see the catalogue if the catalogue is empty**. It will
  say it does not know rather than invent a price, which is correct behaviour but
  reads as unhelpful until you fill in products and the knowledge base.
- **Small local models are noticeably weaker.** Ollama works, but 7B-class
  models with tool calling can loop or miss tools. Test with the *Test* button
  and a handful of real conversations before using one in production.
- **Romanised Nepali is best-effort.** Replies are instructed to match the
  customer's language, but code-mixed Nepali/English is where models make the
  most mistakes.
- **No vision, no speech, no document understanding.**
- **No RAG over long documents.** The knowledge base is injected into the prompt,
  so it must stay short; there is no embedding index, and long entries dilute
  the prompt.
- **Token costs are estimates.** The usage report multiplies provider-reported
  tokens by a price table. It is useful for spotting outliers, not for
  accounting.
- There is **no self-hosted model management** beyond "point it at Ollama".

## Payments

- The eSewa and Khalti adapters follow the published APIs and are covered by
  tests with recorded payloads, but **they have not been run against a live
  merchant account** by the authors. Rehearse with your own sandbox merchant
  account, then with one small real transaction.
- **No subscriptions or recurring billing.**
- **No partial payments, no automatic refunds, no instalments.** Refunds are
  performed in the provider's dashboard; ChatCloser records the event.
- **No stored payment methods.** Every payment is a fresh redirect.
- Cash on delivery is recorded as a payment *instruction*, not verified.

## Tenancy and scale

- **One business per database.** The schema, the services and the API are
  multi-tenant (every row carries `business_id`, every query is scoped), but the
  console, the WhatsApp session and the desktop shell operate on a single
  workspace. There is no workspace switcher and no signup flow.
- **One process.** A single Node process serves the console and the assistant.
  Two instances cannot share the same SQLite file. This is fine for a small
  business and will not be fine for a call centre.
- **SQLite.** Warehoused reporting, concurrent writers at volume and multi-region
  replication are out of scope. WAL mode handles the write volume of a few
  thousand messages a day comfortably.
- **No horizontal scaling, no job queue.** Long-running work (workflow steps,
  follow-ups) runs in-process: a restart loses in-flight timers. Scheduled
  follow-ups are stored in the database and resumed on startup, but an action
  that was mid-flight is not retried.

## Reporting

- **Forecasting is a linear trend over recent history**, clearly labelled as
  such. It is not a statistical model and it does not account for seasonality,
  festivals, or stock-outs.
- Reports are computed on request from the live database; large date ranges on a
  large database are slow and there is no materialised view.
- No export to accounting software (Tally, SAP). CSV is the integration.

## Operational

- **No 2FA.**
- **No email-based password reset.** An owner resets a staff password in the
  console.
- **No auto-update** in the desktop build; install the new version over the old.
- **Deskless support**: there is no remote diagnostics upload. Logs are local
  files.
- **Windows-focused packaging.** The Windows installer and portable build are
  produced and smoke-tested on every release. The macOS (dmg/zip) and Linux
  (AppImage/deb) configurations exist but are not verified to the same degree,
  and no macOS or Linux desktop build has been shipped yet.
- **No code signing.** Windows SmartScreen and macOS Gatekeeper will warn until
  you sign with your own certificate.
- **No HIPAA/PCI/GDPR certification.** Card data never touches the app (redirect
  flows), but that is not the same as a compliance programme.

## Deliberate non-goals

These were considered and rejected for this release, not forgotten:

- Being a CRM. Leads and customers exist to serve conversations, not to replace
  a sales pipeline tool.
- Being a full inventory system. Stock is decremented on confirmed orders and
  restored on cancellation; there are no purchase orders, warehouses or
  transfers.
- Being a website builder. The public booking/catalogue surface is a storefront
  for the assistant, not a CMS.
- Autonomous spending. No tool moves money out, and no workflow can create a
  paid order without a verified provider response.
