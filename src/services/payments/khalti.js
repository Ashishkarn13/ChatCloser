// src/services/payments/khalti.js
// Khalti adapter (KPG-2 Web Checkout).
//
// Reference: https://docs.khalti.com/khalti-epayment/
//
// Flow used here:
//   1. Initiate — POST https://khalti.com/api/v2/epayment/initiate/
//      (sandbox: https://dev.khalti.com/api/v2/epayment/initiate/) with
//      Authorization: Key <secret key> and a JSON body. Returns pidx and
//      payment_url.
//   2. The customer pays and Khalti calls back to return_url.
//   3. Verify  — POST /epayment/lookup/ with the pidx. Only a lookup
//      status of "Completed" counts as paid.
//
// The callback alone is never trusted: Khalti's own documentation requires
// the merchant to confirm the transaction with the lookup API.

export const id = "khalti";
export const label = "Khalti";
export const credentialFields = [
  { key: "secretKey", label: "Khalti secret key", hint: "live_secret_key_… or test_secret_key_…" },
];

const HOSTS = {
  sandbox: "https://dev.khalti.com/api/v2",
  production: "https://khalti.com/api/v2",
};

export function isConfigured(credentials) {
  return Boolean(credentials?.secretKey);
}

function baseUrl(environment) {
  return HOSTS[environment === "production" ? "production" : "sandbox"];
}

export async function createPaymentLink({
  order,
  credentials,
  returnUrl,
  business,
  environment = "sandbox",
  websiteUrl = "https://chatcloser.local",
}) {
  const purchaseOrderId = `cc${business.id}-${order.order_number || order.id}`;
  const amountPaisa = Math.round(Number(order.total_amount ?? order.amount) * 100);

  const payload = {
    return_url: returnUrl,
    website_url: websiteUrl,
    amount: amountPaisa,
    purchase_order_id: purchaseOrderId,
    purchase_order_name: order.item_name || `Order ${order.order_number || order.id}`,
  };

  if (order.customer?.phone) {
    payload.customer_info = { name: order.customer.name || "", phone: order.customer.phone };
  }

  let response;
  try {
    response = await fetch(`${baseUrl(environment)}/epayment/initiate/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${credentials.secretKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Could not reach Khalti: ${err.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Khalti rejected the payment request (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }

  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Khalti returned an unreadable response: ${text.slice(0, 300)}`);
  }

  if (!body.pidx || !body.payment_url) {
    throw new Error(`Khalti did not return a payment URL: ${text.slice(0, 300)}`);
  }

  return {
    providerRef: body.pidx,
    paymentUrl: body.payment_url,
    raw: { pidx: body.pidx, amount: body.amount, expires_at: body.expires_at },
  };
}

/**
 * Lookup call — the authoritative status check.
 */
export async function verify({ providerRef, amount, credentials, environment = "sandbox" }) {
  let response;
  try {
    response = await fetch(`${baseUrl(environment)}/epayment/lookup/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${credentials.secretKey}`,
      },
      body: JSON.stringify({ pidx: providerRef }),
    });
  } catch (err) {
    return {
      verified: false,
      status: "requires_review",
      amount: null,
      detail: `Could not reach Khalti to verify the payment: ${err.message}`,
      raw: {},
    };
  }

  const text = await response.text();
  if (!response.ok) {
    return {
      verified: false,
      status: "requires_review",
      amount: null,
      detail: `Khalti lookup failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
      raw: { statusCode: response.status, body: text.slice(0, 300) },
    };
  }

  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }

  const status = String(body.status || "");
  const reportedPaisa = Number(body.total_amount);
  const reported = Number.isFinite(reportedPaisa) ? reportedPaisa / 100 : null;

  if (status === "Completed") {
    const amountMatches = reported === null ? true : Math.abs(reported - Number(amount)) < 0.005;
    return {
      verified: amountMatches,
      status: amountMatches ? "succeeded" : "requires_review",
      amount: reported,
      detail: amountMatches
        ? "Khalti lookup returned Completed and the amount matches."
        : `Amount mismatch: Khalti reports ${reported}, order expects ${amount}.`,
      raw: body,
    };
  }

  const detail =
    {
      Pending: "Khalti reports the transaction as Pending.",
      Refunded: "Khalti reports the transaction as Refunded.",
      Expired: "The Khalti payment link has expired.",
      Initiated: "The Khalti payment has been initiated but not completed.",
    }[status] || `Khalti lookup returned status "${status || "unknown"}".`;

  return {
    verified: false,
    status: status === "Pending" || status === "Initiated" ? "pending" : "requires_review",
    amount: reported,
    detail,
    raw: body,
  };
}
