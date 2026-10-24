// index.js
// The WhatsApp channel and the always-on bot process.
//
// PAYMENT SAFETY DESIGN (unchanged in intent from ChatCloser 1.x, but the
// implementation is now a real provider adapter):
//   * the assistant proposes an order summary; the order only exists after
//     the customer explicitly confirms it (src/services/orders.js)
//   * prices come from the catalogue, never from the model's own output
//   * a payment link is created through a provider adapter
//   * an order is only marked paid when the provider itself confirms it,
//     through a verified webhook or a server-side verification call
//
// IMPORTANT: this uses Baileys, an unofficial library, not Meta's Cloud
// API. It automates a real WhatsApp account and technically violates
// WhatsApp's Terms of Service. Use a dedicated/spare number for testing,
// not a business's main line. See README.md.

import "dotenv/config";
import fs from "fs";
import express from "express";
import Stripe from "stripe";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";

import { config } from "./src/config.js";
import { getBusiness, saveMessage } from "./db.js";
import { decrypt } from "./crypto-utils.js";
import { fireWebhookEvent } from "./webhooks.js";
import { handleInboundMessage } from "./src/services/ai/engine.js";
import { getOrCreateThread, recordMessage } from "./src/services/conversations.js";
import { findCustomerByPhone } from "./src/services/customers.js";
import { getOrder, listOrders } from "./src/services/orders.js";
import * as payments from "./src/services/payments/index.js";
import { recordProviderEvent, markProviderEventProcessed } from "./src/services/payments/index.js";
import { getBusinessConfig } from "./src/services/businesses.js";
import { ensureReady } from "./src/services/bootstrap.js";
import { fireTrigger, TRIGGERS } from "./src/services/workflows.js";
import { createTask } from "./src/services/tasks.js";
import { createNotification } from "./src/services/notifications.js";
import { audit } from "./src/core/audit.js";

const BUSINESS_ID = config.defaultBusinessId;
const AUTH_DIR = config.authDir;
const CONTROL_PORT = config.controlPort;
const CONTROL_HOST = config.controlHost;

const connectionState = {
  status: "starting",
  qr: null,
  qrDataUrl: null,
  loggedOutIntentionally: false,
};

let sock = null;

// ---------- Rate limiting ----------

const RATE_LIMIT_PER_CHAT_PER_MIN = config.rateLimitPerChatPerMinute;
const RATE_LIMIT_GLOBAL_PER_MIN = config.rateLimitGlobalPerMinute;
const perChatSendTimes = new Map();
const globalSendTimes = [];

function isRateLimited(chatId) {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  const chatTimes = (perChatSendTimes.get(chatId) || []).filter((t) => t > oneMinuteAgo);
  perChatSendTimes.set(chatId, chatTimes);

  const recentGlobal = globalSendTimes.filter((t) => t > oneMinuteAgo);
  globalSendTimes.length = 0;
  globalSendTimes.push(...recentGlobal);

  if (chatTimes.length >= RATE_LIMIT_PER_CHAT_PER_MIN) {
    console.warn(`Rate limit hit for chat ${chatId} — delaying reply.`);
    return true;
  }
  if (globalSendTimes.length >= RATE_LIMIT_GLOBAL_PER_MIN) {
    console.warn(`Global rate limit hit — delaying reply.`);
    return true;
  }
  return false;
}

function recordSend(chatId) {
  const now = Date.now();
  const chatTimes = perChatSendTimes.get(chatId) || [];
  chatTimes.push(now);
  perChatSendTimes.set(chatId, chatTimes);
  globalSendTimes.push(now);
}

function humanDelay() {
  const ms = 1200 + Math.random() * 1800;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendText(chatId, text) {
  if (!sock || connectionState.status !== "connected") {
    console.warn(`Cannot send message — not connected. Chat: ${chatId}`);
    return false;
  }

  let waited = 0;
  while (isRateLimited(chatId) && waited < 65_000) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    waited += 5_000;
  }

  await sock.sendPresenceUpdate("composing", chatId);
  await humanDelay();
  await sock.sendMessage(chatId, { text });
  recordSend(chatId);
  return true;
}

// ---------- payment links ----------

/**
 * Creates a payment for a confirmed order using the business' configured
 * provider and sends the customer the link.
 *
 * If no provider is configured the order simply stays unpaid and the
 * customer is told that the team will send the details — the order is
 * never marked paid.
 */
async function sendPaymentLink(chatId, orderId) {
  const business = getBusinessConfig(BUSINESS_ID);
  const order = getOrder(BUSINESS_ID, orderId);

  const provider = business.npr_payment_method || "";
  if (!provider) {
    await sendText(
      chatId,
      `Your order ${order.order_number} is confirmed. Total ${order.total_amount} ${order.currency}. Our team will send you the payment details shortly.`
    );
    return null;
  }

  try {
    const payment = await payments.createPayment({
      businessId: BUSINESS_ID,
      order,
      provider,
      actor: "system",
      returnUrl: `${config.paymentSuccessUrl || "https://example.com/payment-success"}?order=${order.order_number}`,
      cancelUrl: config.paymentCancelUrl || "https://example.com/payment-cancelled",
    });

    if (payment.paymentUrl) {
      await sendText(
        chatId,
        `Payment link for order ${order.order_number} — ${order.total_amount} ${order.currency}:\n${payment.paymentUrl}\n\nWe will confirm automatically once the payment provider confirms the payment.`
      );
    } else if (payment.instructions) {
      await sendText(chatId, payment.instructions);
    }
    return payment;
  } catch (err) {
    console.error("Payment link creation failed:", err.message);
    await sendText(
      chatId,
      `Your order ${order.order_number} is confirmed, but I could not create the payment link just now. Our team will send it shortly.`
    );
    return null;
  }
}

// ---------- bot ----------

async function startBot() {
  // A fresh installation has no business row yet. Provision it here so the
  // bot can run headless, without anyone opening the dashboard first.
  const provisioned = ensureReady(BUSINESS_ID, {
    name: config.businessName,
    industryTemplate: config.industryTemplate,
    ownerUsername: config.adminUsername,
    ownerPassword: config.adminPassword,
  });
  if (provisioned.owner) {
    console.log(
      `First run: owner account "${provisioned.owner.username}" created. ` +
        "Sign in to the admin panel to change the password."
    );
  }

  const business = getBusiness(BUSINESS_ID);
  if (!business) {
    console.error(`Could not provision business_id=${BUSINESS_ID}.`);
    process.exit(1);
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState.status = "waiting_for_qr";
      connectionState.qr = qr;
      console.log("\nScan this QR code with WhatsApp (Linked Devices > Link a Device):\n");
      qrcode.generate(qr, { small: true });

      try {
        connectionState.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      } catch (err) {
        console.error("Failed to render QR image:", err.message);
        connectionState.qrDataUrl = null;
      }
    }

    if (connection === "close") {
      connectionState.status = "disconnected";
      connectionState.qrDataUrl = null;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (connectionState.loggedOutIntentionally || loggedOut) {
        console.log("Logged out. Restart to link a new account.");
        return;
      }

      console.log("Connection closed. Reconnecting...");
      startBot();
    } else if (connection === "open") {
      connectionState.status = "connected";
      connectionState.qr = null;
      connectionState.qrDataUrl = null;
      console.log(`✅ Connected to WhatsApp. "${business.name}" bot is live.`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const chatId = msg.key.remoteJid;
      const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      if (!messageText.trim()) continue;

      console.log(`📩 [${chatId}] ${messageText}`);

      const thread = getOrCreateThread(BUSINESS_ID, "whatsapp", chatId);
      recordMessage(BUSINESS_ID, thread, "user", messageText);

      const sender = msg.key.participant || chatId;
      const customer = findCustomerByPhone(BUSINESS_ID, sender);

      let outcome;
      try {
        outcome = await handleInboundMessage({
          businessId: BUSINESS_ID,
          message: messageText,
          channel: "whatsapp",
          externalId: chatId,
          customerName: customer?.name || "",
          customerPhone: customer?.phone || sender,
          send: async (text) => {
            await sendText(chatId, text);
          },
        });
      } catch (err) {
        console.error("Message handling failed:", err);
        await sendText(
          chatId,
          "Sorry — something went wrong on our side. A member of our team will follow up shortly."
        );
        continue;
      }

      // The order may have been confirmed during this turn: create the
      // payment link for it.
      const confirmed = (outcome.toolResults || []).find(
        (t) => t.name === "confirm_customer_order" && t.ok && t.result?.orderId
      );
      if (confirmed) {
        await sendPaymentLink(chatId, confirmed.result.orderId);
        await fireTrigger(BUSINESS_ID, TRIGGERS.ORDER_CONFIRMED, {
          orderId: confirmed.result.orderId,
          chatId,
          triggerEvent: "order_confirmed",
        });
      }

      const escalated = (outcome.toolResults || []).find(
        (t) => t.name === "request_human_takeover" && t.ok
      );
      if (escalated) {
        createTask(BUSINESS_ID, {
          title: `Customer requested a person${customer?.name ? ` — ${customer.name}` : ""}`,
          description: `Conversation ${chatId} was handed to a human.`,
          priority: "high",
          entityType: "conversation",
          entityId: thread.id,
        });
        createNotification(BUSINESS_ID, {
          title: "Conversation handed to a human",
          body: `Chat ${chatId} needs a reply from the team.`,
          category: "escalation",
          severity: "warning",
        });
        fireWebhookEvent(BUSINESS_ID, "escalation.triggered", { chat_id: chatId, message: messageText });
      }

      await fireTrigger(BUSINESS_ID, TRIGGERS.MESSAGE_RECEIVED, {
        threadId: thread.id,
        chatId,
        customerId: customer?.id || null,
        message: messageText,
        intent: outcome.intent,
        language: outcome.language,
        triggerEvent: "message_received",
      });
    }
  });
}

// ---------- Internal control API ----------
//
// Binds to 127.0.0.1 by default: the endpoints can log the WhatsApp
// account out, so they must never be reachable from the network.

const controlApp = express();

controlApp.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const business = getBusinessConfig(BUSINESS_ID);
  if (!business?.stripe_webhook_secret_encrypted) {
    console.error("Stripe webhook received but no webhook secret is configured.");
    return res.status(400).send("Webhook not configured");
  }

  let event;
  try {
    const webhookSecret = decrypt(business.stripe_webhook_secret_encrypted);
    const stripeSecretKey = decrypt(business.stripe_secret_key_encrypted);
    const stripe = new Stripe(stripeSecretKey);
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send("Webhook signature verification failed");
  }

  // Idempotent intake: Stripe retries, and the same event must not be
  // processed twice.
  const intake = recordProviderEvent(
    BUSINESS_ID,
    "stripe",
    event.id,
    event.type,
    ""
  );
  if (intake.duplicate) {
    return res.json({ received: true, duplicate: true });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const order = await settleStripeSession(session);
      markProviderEventProcessed(BUSINESS_ID, "stripe", event.id);
      if (order) {
        await fireTrigger(BUSINESS_ID, TRIGGERS.PAYMENT_VERIFIED, {
          orderId: order.id,
          chatId: order.chat_id,
          triggerEvent: "payment_verified",
        });
      }
    } else {
      markProviderEventProcessed(BUSINESS_ID, "stripe", event.id);
    }
    return res.json({ received: true });
  } catch (err) {
    markProviderEventProcessed(BUSINESS_ID, "stripe", event.id, "failed", err.message);
    console.error("Stripe webhook processing failed:", err);
    return res.status(500).send("Webhook processing failed");
  }
});

/**
 * Verifies a Stripe Checkout Session against the local order and marks it
 * paid only if the provider confirms it and the amount matches.
 */
async function settleStripeSession(session) {
  const db = (await import("./src/db/connection.js")).getDb();
  const order = db
    .prepare("SELECT * FROM orders WHERE business_id = ? AND stripe_checkout_session_id = ?")
    .get(BUSINESS_ID, session.id);

  if (!order) {
    console.error(`Stripe webhook confirmed a session (${session.id}) with no matching local order.`);
    return null;
  }

  if (order.payment_status === "paid") {
    // Already settled — nothing to do, and definitely no second message.
    return order;
  }

  const expected = Number(order.total_amount ?? order.amount ?? 0);
  const received = (session.amount_total || 0) / 100;

  if (Math.abs(received - expected) >= 0.005) {
    console.error(
      `Stripe amount mismatch for order ${order.id}: expected ${expected}, received ${received}. Not marking paid.`
    );
    audit({
      businessId: BUSINESS_ID,
      actor: "stripe",
      action: "payment.amount_mismatch",
      details: { order_id: order.id, expected, received },
      severity: "critical",
    });
    return null;
  }

  db.prepare(
    "UPDATE orders SET payment_status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(BUSINESS_ID, order.id);

  db.prepare(
    "UPDATE payments SET status = 'succeeded', verified = 1, verified_at = CURRENT_TIMESTAMP, verification_detail = ? WHERE business_id = ? AND order_id = ?"
  ).run("Confirmed by Stripe webhook.", BUSINESS_ID, order.id);

  const updated = getOrder(BUSINESS_ID, order.id);

  // The confirmation message is fixed template text, never AI-generated.
  await sendText(
    order.chat_id,
    `✅ Payment received — thank you! Your order ${order.order_number} (${order.total_amount} ${order.currency}) is confirmed. We'll be in touch with next steps shortly.`
  );

  console.log(`💰 Order ${order.id} marked PAID via verified Stripe webhook.`);
  fireWebhookEvent(BUSINESS_ID, "order.paid", {
    order_id: order.id,
    chat_id: order.chat_id,
    item_name: order.item_name,
    amount: order.total_amount,
    currency: order.currency,
  });

  return updated;
}

// Nepal provider callbacks: eSewa and Khalti.
controlApp.post("/webhooks/nepal/:provider", express.urlencoded({ extended: true }), async (req, res) => {
  const provider = req.params.provider;
  const body = req.body || {};

  const eventId = body.transaction_id || body.pidx || body.tid || body.ref_id || "";
  if (!eventId) return res.status(400).send("Missing transaction reference.");

  const intake = recordProviderEvent(BUSINESS_ID, provider, eventId, "payment_callback", "");
  if (intake.duplicate) return res.json({ received: true, duplicate: true });

  try {
    const payment = await findPaymentByReference(provider, eventId);
    if (!payment) {
      markProviderEventProcessed(BUSINESS_ID, provider, eventId, "ignored", "no matching payment");
      return res.json({ received: true, matched: false });
    }

    const result = await payments.verifyPayment({
      businessId: BUSINESS_ID,
      paymentId: payment.id,
      actor: `${provider}-webhook`,
    });

    markProviderEventProcessed(BUSINESS_ID, provider, eventId);
    res.json({ received: true, matched: true, status: result.status });
  } catch (err) {
    markProviderEventProcessed(BUSINESS_ID, provider, eventId, "failed", err.message);
    console.error(`${provider} webhook processing failed:`, err.message);
    res.status(500).send("Webhook processing failed");
  }
});

async function findPaymentByReference(provider, reference) {
  const db = (await import("./src/db/connection.js")).getDb();
  return db
    .prepare("SELECT * FROM payments WHERE business_id = ? AND provider = ? AND provider_ref = ?")
    .get(BUSINESS_ID, provider, reference);
}

controlApp.use(express.json());

controlApp.get("/status", (req, res) => {
  res.json({ status: connectionState.status });
});

controlApp.get("/health", (req, res) => {
  res.json({
    status: "ok",
    whatsapp: connectionState.status,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

controlApp.get("/qr", (req, res) => {
  res.json({
    status: connectionState.status,
    qrDataUrl: connectionState.status === "waiting_for_qr" ? connectionState.qrDataUrl : null,
  });
});

controlApp.post("/logout", async (req, res) => {
  connectionState.loggedOutIntentionally = true;
  connectionState.qrDataUrl = null;
  try {
    if (sock) await sock.logout();
  } catch (err) {
    console.error("Logout error (continuing anyway):", err.message);
  }
  try {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error("Failed to clear auth_info:", err.message);
  }
  connectionState.status = "disconnected";
  res.json({ ok: true, message: "Logged out. Restart the bot process to link a new WhatsApp account." });
});

controlApp.listen(CONTROL_PORT, CONTROL_HOST, () => {
  console.log(`Bot control API listening on ${CONTROL_HOST}:${CONTROL_PORT}`);
});

if (process.env.CHATCLOSER_NO_LISTEN !== "1") {
  if (!config.whatsappEnabled) {
    // The admin panel, payments and reporting all work without WhatsApp;
    // the channel is switched off deliberately here (WHATSAPP_ENABLED=false),
    // for example while the number is being moved between devices.
    connectionState.status = "disabled";
    console.log("WhatsApp is disabled (WHATSAPP_ENABLED=false); the dashboard is unaffected.");
  } else {
    startBot().catch((err) => {
      console.error("Failed to start bot:", err);
      process.exit(1);
    });
  }
}

export { startBot, sendText, controlApp };
