// index.js
// Connects to WhatsApp using Baileys, listens for incoming messages, and
// replies using whichever AI provider the business has configured —
// persisting every message, captured lead, and order to SQLite.
//
// Also runs a small internal control API (separate port) that the
// dashboard calls for status/logout, and that Stripe calls to deliver
// payment webhook events. And runs a scheduled job that autonomously
// follows up with leads nobody has responded to yet.
//
// PAYMENT SAFETY DESIGN: when the AI calls close_sale, this file looks up
// the item_name against the business's REAL price_list table — the AI's
// price claims are never trusted directly. A Stripe Checkout link is
// generated for the verified amount and sent via a fixed template message
// (never AI-generated text). The order is only ever marked "paid" when a
// verified Stripe webhook event arrives — never based on anything the AI
// says. This is how "fully autonomous" is achieved without letting the
// AI's own text be the source of truth for money changing hands.
//
// IMPORTANT: This uses Baileys, an unofficial library, not Meta's Cloud
// API. It automates a real WhatsApp account and technically violates
// WhatsApp's Terms of Service. Use a dedicated/burner number for testing,
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
import { generateReply, shouldEscalate } from "./ai.js";
import {
  getBusiness,
  saveMessage,
  getHistory,
  createLead,
  getPriceItemByName,
  createOrder,
  attachStripeSession,
  markOrderPaid,
  getStaleLeads,
  markLeadNudged,
} from "./db.js";
import { decrypt } from "./crypto-utils.js";
import { fireWebhookEvent } from "./webhooks.js";

const BUSINESS_ID = Number(process.env.BUSINESS_ID || 1);
const AUTH_DIR = "./auth_info";
const CONTROL_PORT = process.env.BOT_CONTROL_PORT || 3002;
const NUDGE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // check hourly
const NUDGE_AFTER_HOURS = Number(process.env.NUDGE_AFTER_HOURS || 24);

const escalatedChats = new Set();

// ---------- Rate limiting ----------
// Guards against runaway loops and reduces WhatsApp ban risk from
// sending too fast. Two layers: per-chat (don't hammer one customer)
// and global (don't blast many different chats too fast in aggregate).
const RATE_LIMIT_PER_CHAT_PER_MIN = Number(process.env.RATE_LIMIT_PER_CHAT_PER_MIN || 6);
const RATE_LIMIT_GLOBAL_PER_MIN = Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN || 30);
const perChatSendTimes = new Map(); // chatId -> array of send timestamps (ms)
const globalSendTimes = []; // array of send timestamps (ms)

function isRateLimited(chatId) {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  const chatTimes = (perChatSendTimes.get(chatId) || []).filter((t) => t > oneMinuteAgo);
  perChatSendTimes.set(chatId, chatTimes);

  const recentGlobal = globalSendTimes.filter((t) => t > oneMinuteAgo);
  globalSendTimes.length = 0;
  globalSendTimes.push(...recentGlobal);

  if (chatTimes.length >= RATE_LIMIT_PER_CHAT_PER_MIN) {
    console.warn(`Rate limit hit for chat ${chatId} (${chatTimes.length}/${RATE_LIMIT_PER_CHAT_PER_MIN} per minute) — delaying reply.`);
    return true;
  }
  if (globalSendTimes.length >= RATE_LIMIT_GLOBAL_PER_MIN) {
    console.warn(`Global rate limit hit (${globalSendTimes.length}/${RATE_LIMIT_GLOBAL_PER_MIN} per minute) — delaying reply.`);
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

const connectionState = {
  status: "starting",
  qr: null,
  qrDataUrl: null,
  loggedOutIntentionally: false,
};

let sock = null;

function humanDelay() {
  const ms = 1200 + Math.random() * 1800;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendText(chatId, text) {
  // If rate-limited, wait and retry once rather than dropping the
  // message entirely — a customer should still get their reply, just
  // not instantly during a burst.
  let waited = 0;
  while (isRateLimited(chatId) && waited < 65_000) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    waited += 5_000;
  }

  await sock.sendPresenceUpdate("composing", chatId);
  await humanDelay();
  await sock.sendMessage(chatId, { text });
  recordSend(chatId);
  saveMessage(BUSINESS_ID, chatId, "assistant", text);
}

/**
 * Handles a close_sale tool call from the AI. Verifies the item against
 * the real price list, creates a Stripe Checkout session for that exact
 * verified amount, saves the order, and sends the customer a fixed
 * template message with the payment link. Never trusts the AI's own
 * price claim.
 */
async function handleSaleRequest(chatId, leadId, saleRequest, business) {
  const priceItem = getPriceItemByName(BUSINESS_ID, saleRequest.item_name);

  if (!priceItem) {
    console.error(
      `close_sale called with item_name "${saleRequest.item_name}" which is not in the price list — ignoring, this should not happen if the AI followed instructions.`
    );
    await sendText(
      chatId,
      "Sorry, I wasn't able to generate a payment link for that just now — let me have someone from our team follow up with you directly."
    );
    return;
  }

  if (!business.stripe_secret_key_encrypted) {
    console.error(`close_sale triggered but no Stripe key configured for business_id=${BUSINESS_ID}.`);
    await sendText(
      chatId,
      "Thanks for confirming! Our payment system is being set up right now — someone from our team will send you a payment link shortly."
    );
    return;
  }

  try {
    const stripeSecretKey = decrypt(business.stripe_secret_key_encrypted);
    const stripe = new Stripe(stripeSecretKey);

    const order = createOrder(BUSINESS_ID, chatId, leadId, {
      item_name: priceItem.item_name,
      amount: priceItem.price_amount,
      currency: priceItem.currency,
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: priceItem.currency.toLowerCase(),
            product_data: { name: priceItem.item_name },
            unit_amount: Math.round(priceItem.price_amount * 100), // Stripe uses the smallest currency unit
          },
          quantity: 1,
        },
      ],
      success_url: process.env.PAYMENT_SUCCESS_URL || "https://example.com/payment-success",
      cancel_url: process.env.PAYMENT_CANCEL_URL || "https://example.com/payment-cancelled",
      metadata: { business_id: String(BUSINESS_ID), order_id: String(order.id), chat_id: chatId },
    });

    attachStripeSession(order.id, { stripeSessionId: session.id, paymentUrl: session.url });

    // Fixed template message — deliberately NOT AI-generated, so there's
    // no chance of the AI wording implying payment is already confirmed.
    await sendText(
      chatId,
      `Great — here's your secure payment link for ${priceItem.item_name} (${priceItem.price_amount} ${priceItem.currency}):\n${session.url}\n\nOnce your payment goes through, I'll confirm it right here automatically.`
    );

    console.log(`💳 Payment link created for order ${order.id} (${priceItem.item_name}, ${priceItem.price_amount} ${priceItem.currency})`);
  } catch (err) {
    console.error("Stripe checkout creation failed:", err.message);
    await sendText(
      chatId,
      "Sorry, I ran into an issue generating your payment link. Someone from our team will follow up to sort this out."
    );
  }
}

async function startBot() {
  const business = getBusiness(BUSINESS_ID);
  if (!business) {
    console.error(`No business found for business_id=${BUSINESS_ID}. Run "node seed.js" first, or start the dashboard once to auto-create one.`);
    process.exit(1);
  }

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

      // Also render a real QR image for the admin panel — the terminal
      // ASCII version above still prints too, for anyone watching there.
      try {
        connectionState.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      } catch (err) {
        console.error("Failed to render QR image for admin panel:", err.message);
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
      const messageText =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!messageText.trim()) continue;

      console.log(`📩 [${chatId}] ${messageText}`);
      saveMessage(BUSINESS_ID, chatId, "user", messageText);

      const currentBusiness = getBusiness(BUSINESS_ID);

      if (shouldEscalate(currentBusiness, messageText) && !escalatedChats.has(chatId)) {
        escalatedChats.add(chatId);
        await sendText(chatId, currentBusiness.escalation_message);
        fireWebhookEvent(BUSINESS_ID, "escalation.triggered", { chat_id: chatId, message: messageText });
        continue;
      }

      if (escalatedChats.has(chatId)) {
        continue;
      }

      const history = getHistory(BUSINESS_ID, chatId, 10);
      const { reply, capturedLead, saleRequest } = await generateReply(BUSINESS_ID, history);

      let leadId = null;
      if (capturedLead) {
        const lead = createLead(BUSINESS_ID, chatId, capturedLead);
        leadId = lead.id;
        console.log(`🎯 Lead captured [id=${lead.id}] for chat ${chatId}:`, capturedLead);
        fireWebhookEvent(BUSINESS_ID, "lead.captured", { lead_id: lead.id, chat_id: chatId, ...capturedLead });
      }

      await sendText(chatId, reply);

      if (saleRequest) {
        await handleSaleRequest(chatId, leadId, saleRequest, currentBusiness);
      }
    }
  });
}

// ---------- Autonomous follow-up: nudge stale leads ----------

async function runNudgeCheck() {
  try {
    const staleLeads = getStaleLeads(BUSINESS_ID, NUDGE_AFTER_HOURS);
    for (const lead of staleLeads) {
      if (!sock || connectionState.status !== "connected") break;
      await sendText(
        lead.chat_id,
        `Hi again! Just checking in — are you still interested in ${lead.service_requested || "the service you asked about"}? Happy to help whenever you're ready.`
      );
      markLeadNudged(lead.id);
      console.log(`👋 Sent autonomous follow-up nudge for lead ${lead.id}`);
    }
  } catch (err) {
    console.error("Nudge check failed:", err.message);
  }
}

setInterval(runNudgeCheck, NUDGE_CHECK_INTERVAL_MS);

// ---------- Internal control API (dashboard status/logout + Stripe webhook) ----------

const controlApp = express();

// Stripe webhook needs the RAW request body for signature verification,
// so this route is registered with its own raw parser BEFORE the global
// express.json() below — do not move this after the json() middleware.
controlApp.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const business = getBusiness(BUSINESS_ID);
  if (!business?.stripe_webhook_secret_encrypted) {
    console.error("Stripe webhook received but no webhook secret configured.");
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
    return res.status(400).send(`Webhook signature verification failed`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const order = markOrderPaid(session.id);
    if (order && sock && connectionState.status === "connected") {
      // Fixed, deterministic confirmation — triggered ONLY by this
      // verified webhook event, never by AI-generated text.
      await sendText(
        order.chat_id,
        `✅ Payment received — thank you! Your order for ${order.item_name} (${order.amount} ${order.currency}) is confirmed. We'll be in touch with next steps shortly.`
      );
      console.log(`💰 Order ${order.id} marked PAID via verified Stripe webhook.`);
      fireWebhookEvent(BUSINESS_ID, "order.paid", {
        order_id: order.id, chat_id: order.chat_id, item_name: order.item_name,
        amount: order.amount, currency: order.currency,
      });
    } else if (!order) {
      console.error(`Stripe webhook confirmed a session (${session.id}) with no matching local order.`);
    }
  }

  res.json({ received: true });
});

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
  setTimeout(() => process.exit(0), 500);
});

controlApp.listen(CONTROL_PORT, () => {
  console.log(`Bot control API listening on port ${CONTROL_PORT} (dashboard status/logout + Stripe webhook)`);
});

startBot().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
