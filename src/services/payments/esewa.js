// src/services/payments/esewa.js
// eSewa adapter (Epay V2).
//
// Reference: https://developer.esewa.com.np/pages/Epay-V2
//
// Flow used here:
//   1. Initiate  — POST /api/epay/transaction/initiate/ with an HMAC-SHA256
//      signature over the signed field names. Returns the redirect URL.
//   2. The customer pays on eSewa and is redirected back to success_url.
//   3. Verify   — server-to-server GET /api/epay/transaction/status/ with
//      product_code, total_amount and transaction_uuid. Only a status of
//      COMPLETE counts as paid.
//
// The status check is the *only* thing that can mark an order paid. The
// customer's browser redirect, the customer's own message and any AI
// statement are all ignored.
//
// Sandbox: product code "EPAYTEST", status endpoint
//   https://rc.esewa.com.np/api/epay/transaction/status/
// Production: product code issued by eSewa on merchant onboarding.

import crypto from "node:crypto";

export const id = "esewa";
export const label = "eSewa";
export const credentialFields = [
  { key: "merchantCode", label: "eSewa product code / merchant code", hint: "e.g. EPAYTEST" },
  { key: "secretKey", label: "eSewa secret key", hint: "used to sign and verify requests" },
];

const HOSTS = {
  sandbox: "https://rc.esewa.com.np",
  production: "https://esewa.com.np",
};

export function isConfigured(credentials) {
  return Boolean(credentials?.merchantCode && credentials?.secretKey);
}

/**
 * eSewa's signature: HMAC-SHA256 (base64) over the values of the signed
 * fields joined by "," in the order they are declared.
 */
export function signPayload(payload, signedFieldNames, secretKey) {
  const values = signedFieldNames
    .split(",")
    .map((name) => String(payload[name] ?? ""))
    .join(",");
  return crypto.createHmac("sha256", secretKey).update(values).digest("base64");
}

function endpoint(kind, environment) {
  const host = HOSTS[environment === "production" ? "production" : "sandbox"];
  return `${host}/api/epay/transaction/${kind}/`;
}

export async function createPaymentLink({ order, credentials, returnUrl, failUrl, business, environment = "sandbox" }) {
  const transactionUuid = `cc${business.id}-${order.order_number || order.id}-${Date.now()}`;
  const amount = Number(order.total_amount ?? order.amount);

  const payload = {
    amount: String(amount),
    tax_amount: String(Number(order.tax_amount || 0)),
    product_service_charge: "0",
    product_delivery_charge: String(Number(order.delivery_amount || 0)),
    product_code: credentials.merchantCode,
    total_amount: String(amount),
    transaction_uuid: transactionUuid,
    success_url: returnUrl,
    failure_url: failUrl,
    signed_field_names: "amount,tax_amount,product_service_charge,product_delivery_charge,product_code,total_amount,transaction_uuid,success_url,failure_url",
  };

  payload.signature = signPayload(payload, payload.signed_field_names, credentials.secretKey);

  const body = new URLSearchParams(payload).toString();

  let response;
  try {
    response = await fetch(endpoint("initiate", environment), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw new Error(`Could not reach eSewa: ${err.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`eSewa rejected the payment request (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }

  // eSewa answers with a JSON body containing the redirect URL.
  let redirectUrl = null;
  try {
    const parsed = JSON.parse(text);
    redirectUrl = parsed.redirect_url || parsed.redirectUrl || null;
  } catch {
    redirectUrl = null;
  }

  if (!redirectUrl) {
    throw new Error(`eSewa did not return a payment URL: ${text.slice(0, 300)}`);
  }

  return {
    providerRef: transactionUuid,
    paymentUrl: redirectUrl,
    raw: { transaction_uuid: transactionUuid, amount, product_code: credentials.merchantCode },
  };
}

/**
 * Server-to-server status check. Only "COMPLETE" is treated as paid.
 */
export async function verify({ providerRef, amount, credentials, environment = "sandbox" }) {
  const url = new URL(endpoint("status", environment));
  url.searchParams.set("product_code", credentials.merchantCode);
  url.searchParams.set("total_amount", String(Number(amount)));
  url.searchParams.set("transaction_uuid", providerRef);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    return {
      verified: false,
      status: "requires_review",
      amount: null,
      detail: `Could not reach eSewa to verify the payment: ${err.message}`,
      raw: {},
    };
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 300) };
  }

  const status = String(payload.status || "").toUpperCase();
  const reported = Number(payload.total_amount);

  if (status === "COMPLETE") {
    const amountMatches = Number.isFinite(reported)
      ? Math.abs(reported - Number(amount)) < 0.005
      : true;
    return {
      verified: amountMatches,
      status: amountMatches ? "succeeded" : "requires_review",
      amount: Number.isFinite(reported) ? reported : null,
      detail: amountMatches
        ? "eSewa status check returned COMPLETE."
        : `Amount mismatch: eSewa reports ${reported}, order expects ${amount}.`,
      raw: payload,
    };
  }

  const detail =
    {
      PENDING: "eSewa reports the transaction as PENDING.",
      AMBIGUOUS: "eSewa reports the transaction as AMBIGUOUS.",
      FULL_REFUND: "eSewa reports the transaction as fully refunded.",
      PARTIAL_REFUND: "eSewa reports the transaction as partially refunded.",
      NOT_FOUND: "eSewa has no record of this transaction.",
    }[status] || `eSewa status check returned "${payload.status || text.slice(0, 120)}".`;

  return {
    verified: false,
    status: status === "PENDING" ? "pending" : "requires_review",
    amount: Number.isFinite(reported) ? reported : null,
    detail,
    raw: payload,
  };
}

/**
 * Verifies the signature on eSewa's base64-encoded redirect payload.
 * Returns the decoded payload when the signature matches, otherwise null.
 */
export function verifyCallbackSignature({ credentials, encodedData }) {
  if (!encodedData || !credentials?.secretKey) return null;
  try {
    const decoded = JSON.parse(Buffer.from(encodedData, "base64").toString("utf8"));
    const expected = signPayload(decoded, decoded.signed_field_names, credentials.secretKey);
    if (!decoded.signature) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(decoded.signature)))) return null;
    return decoded;
  } catch {
    return null;
  }
}
