// webhooks.js
// Fires outbound webhook notifications to whatever URLs a business has
// registered in the admin panel, for events like a new lead or a paid
// order — lets them pipe this bot into their own CRM, Zapier, Slack, etc.
//
// Every payload is HMAC-SHA256 signed with the webhook's own secret (sent
// as the X-Webhook-Signature header) so the receiving end can verify it
// really came from here. Delivery is fire-and-forget: a slow or failing
// webhook endpoint must never delay or break a WhatsApp reply.
//
// Every attempt (including retries) is logged to webhook_deliveries so
// the admin panel can show a real delivery history instead of a black box.
// On failure, one automatic retry is attempted after 30 seconds — this is
// deliberately simple (no backoff queue, no persistence across restarts)
// since a full retry/dead-letter system is out of scope for this project's size.

import crypto from "crypto";
import { getWebhooksForEvent, logWebhookDelivery } from "./db.js";

const RETRY_DELAY_MS = 30_000;

function sign(secret, payloadString) {
  return crypto.createHmac("sha256", secret).update(payloadString).digest("hex");
}

async function attemptDelivery(webhook, payloadString, eventName) {
  const signature = sign(webhook.secret, payloadString);
  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Event": eventName,
      },
      body: payloadString,
    });
    return { success: res.ok, status: res.status, error: res.ok ? "" : `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, status: null, error: err.message };
  }
}

async function deliverWithRetry(businessId, webhook, eventName, payloadString) {
  const first = await attemptDelivery(webhook, payloadString, eventName);
  logWebhookDelivery(businessId, {
    webhookId: webhook.id, event: eventName, url: webhook.url,
    success: first.success, responseStatus: first.status, error: first.error, attempt: 1,
  });
  if (first.success) return;

  console.warn(`Webhook to ${webhook.url} failed (${first.error}) — retrying once in ${RETRY_DELAY_MS / 1000}s.`);
  setTimeout(async () => {
    const retry = await attemptDelivery(webhook, payloadString, eventName);
    logWebhookDelivery(businessId, {
      webhookId: webhook.id, event: eventName, url: webhook.url,
      success: retry.success, responseStatus: retry.status, error: retry.error, attempt: 2,
    });
    if (!retry.success) {
      console.error(`Webhook to ${webhook.url} failed again on retry (${retry.error}). Giving up — check the Webhooks tab's delivery log.`);
    }
  }, RETRY_DELAY_MS);
}

/**
 * Fire an event to every webhook this business has subscribed for it.
 * Never throws — logs and swallows delivery failures so a broken
 * third-party endpoint can't affect the bot itself.
 */
export async function fireWebhookEvent(businessId, eventName, data) {
  let subscribers;
  try {
    subscribers = getWebhooksForEvent(businessId, eventName);
  } catch (err) {
    console.error("Failed to look up webhooks:", err.message);
    return;
  }

  if (subscribers.length === 0) return;

  const payload = {
    event: eventName,
    business_id: businessId,
    timestamp: new Date().toISOString(),
    data,
  };
  const payloadString = JSON.stringify(payload);

  for (const webhook of subscribers) {
    // Deliberately not awaited — see file header. Errors are caught and
    // logged inside deliverWithRetry itself.
    deliverWithRetry(businessId, webhook, eventName, payloadString);
  }
}
