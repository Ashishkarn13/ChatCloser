# Payments

Nepal first: eSewa and Khalti are the default rails, Stripe is there for
international cards, and manual transfer covers the rest.

The rule that governs all of it: **an order is only paid when the payment
provider says so.** Not when the customer says so, not when the browser
redirects back, not when the assistant thinks it went through.

---

## Configure

**Integrations → Payments** in the console. Secrets are encrypted with
`ENCRYPTION_KEY` and stored in the database; they are never shown again, only
masked. Every provider has a sandbox and a production mode — test in sandbox
first, then switch the mode and re-enter production credentials.

### eSewa (Epay V2)

| Field | Where to get it |
| --- | --- |
| Merchant code / product code | `EPAYTEST` for sandbox; issued by eSewa on merchant onboarding |
| Secret key | Same place as the merchant code |

How it works:

1. ChatCloser calls `POST /api/epay/transaction/initiate/` with an
   HMAC-SHA256 signature over the signed field names, and gets a redirect URL.
2. The customer pays on eSewa and is sent back to `success_url`.
3. ChatCloser **ignores the redirect** and calls
   `GET /api/epay/transaction/status/` server-side. Only `COMPLETE` marks the
   order paid.

Endpoints: sandbox `https://rc.esewa.com.np`, production `https://esewa.com.np`.

### Khalti (ePayment v2)

| Field | Where to get it |
| --- | --- |
| Secret key | `test_secret_key_…` for sandbox, `live_secret_key_…` for production |

How it works: initiate with `POST /api/v2/epayment/initiate/`, the customer pays,
Khalti calls `return_url`, and ChatCloser independently calls
`POST /api/v2/epayment/lookup/` with the `pidx` before it marks anything paid.

Endpoints: sandbox `https://dev.khalti.com/api/v2`, production
`https://khalti.com/api/v2`.

### Stripe

| Field | Where to get it |
| --- | --- |
| Secret key | Stripe dashboard → Developers → API keys |
| Webhook signing secret | Stripe dashboard → Developers → Webhooks → your endpoint |

Create the endpoint as:

```
https://chat.example.com/webhooks/stripe
```

with at least `checkout.session.completed` and
`checkout.session.async_payment_succeeded` enabled. ChatCloser verifies the
signature against the raw body, checks the session server-side with Stripe, and
deduplicates by event id (a replayed webhook changes nothing).

### Manual transfer / QR

Configure the instructions once (bank, account number, QR image link). The
customer is shown them in chat, and a staff member with `payments.approve`
confirms the receipt in **Payments → Approve**. The confirmation is recorded in
the audit log with the staff member's name; that is the only way a manual
payment becomes `paid`.

---

## The payment lifecycle

```
order confirmed
      │
      ├─ no provider configured ──► customer told the team will follow up
      │
      └─ payment link created ──► pending
                                    │
              ┌─────────────────────┼──────────────────────┐
              │                     │                      │
        provider webhook      server-side lookup      staff approval
        (signature ok)        (COMPLETE / Completed)   (manual only)
              │                     │                      │
              └────────────► verified ◄────────────────────┘
                                │
                        order → paid, stock → consumed,
                        workflow "payment_verified" fires,
                        receipt recorded
```

Failure and edge cases:

- **Amount mismatch.** A provider confirming a different amount than the order
  total does not mark it paid; the payment is flagged for review.
- **Duplicate callbacks.** Deduplicated by provider event id / `pidx` /
  transaction uuid.
- **Cancelled or abandoned.** The payment stays `pending`; the order stays
  `confirmed`. Nothing is refunded automatically — refunds are manual.
- **Provider down.** Payments remain pending and the console shows them under
  *unverified payments*. `reconcileOrder` re-checks on demand.
- **Reconciliation.** **Payments → Reconcile** asks the provider again for the
  current state of a pending payment.

---

## Going live

1. Complete merchant onboarding with eSewa and/or Khalti; you need their
   production merchant code and keys.
2. Set `PAYMENT_SUCCESS_URL` and `PAYMENT_CANCEL_URL` to your public origin.
3. Put the webhook paths behind the proxy (see
   [DEPLOYMENT.md](DEPLOYMENT.md)) if you use Stripe or provider callbacks.
4. Run one real transaction of the smallest possible amount.
5. Check **Payments**: status `succeeded`, verified `provider`, and the order
   marked `paid`. Then check the AI usage/audit log shows the verification.
6. Refund that test transaction from the provider's dashboard.

> The eSewa and Khalti adapters are implemented against the published APIs and
> covered by tests with recorded payloads. They have **not** been run against a
> live merchant account by the authors. Do step 4–6 before trusting them with
> real money.

---

## What is never done

- Reading the `succeeded` flag from the customer's redirect URL.
- Trusting a webhook without a signature check.
- Trusting the AI's statement that a payment succeeded.
- Marking an order paid because a link was *created*.
- Storing card data. Redirect flows only; card numbers never touch ChatCloser.
