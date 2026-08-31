// ai.js
// Builds the system prompt from the business's stored knowledge base and
// price list, calls whichever AI provider the business has configured,
// and handles the escalation-keyword fast path.
//
// IMPORTANT DESIGN NOTE ON AUTONOMOUS SALES:
// The AI is given the exact price list and may call close_sale once a
// customer has clearly agreed to buy a specific item. But the AI's output
// is NEVER treated as proof of a sale or payment — index.js looks up the
// item_name the AI returned against the real price_list table before
// creating any payment link, and payment is only ever marked "paid" by a
// verified Stripe webhook event (see index.js), never by anything the AI
// says. This keeps "fully autonomous" (no human has to intervene) without
// ever letting the AI's text be the source of truth for money.

import { getBusiness, getPriceList } from "./db.js";
import { decrypt } from "./crypto-utils.js";
import { getProvider } from "./providers/index.js";

const CAPTURE_LEAD_TOOL = {
  name: "capture_lead",
  description:
    "Call this once you have enough information to pass a qualified lead to the business's human team. Do not call this for general questions with no service interest expressed.",
  input_schema: {
    type: "object",
    properties: {
      customer_name: { type: "string", description: "Customer's name, if given" },
      contact_number: { type: "string", description: "Best number to reach them, if different from their WhatsApp number" },
      service_requested: { type: "string", description: "What service/work they're interested in" },
      location: { type: "string", description: "Their location/area, if given" },
      urgency: { type: "string", description: "How urgent this seems, e.g. low/medium/high or a short phrase" },
      preferred_date: { type: "string", description: "Preferred date/timeframe, if given" },
      notes: { type: "string", description: "Anything else relevant" },
    },
    required: ["service_requested"],
  },
};

const CLOSE_SALE_TOOL = {
  name: "close_sale",
  description:
    "Call this ONLY when the customer has clearly and explicitly agreed to purchase a specific item, and you have confirmed the exact item name and price with them in the conversation. item_name MUST exactly match one of the items in the PRICE LIST below — never call this for an item not on the list, and never state or imply a price that isn't on the list. This generates a real payment link, so only call it when the customer has actually agreed to buy.",
  input_schema: {
    type: "object",
    properties: {
      item_name: { type: "string", description: "Must exactly match an item name from the PRICE LIST" },
      customer_name: { type: "string", description: "Customer's name, if known" },
    },
    required: ["item_name"],
  },
};

function buildSystemPrompt(business, priceList) {
  const kbLines = Object.entries(business.knowledge_base)
    .map(([key, value]) => `- ${key.replace(/_/g, " ")}: ${value}`)
    .join("\n");

  let priceListSection = "";
  if (priceList.length > 0) {
    const priceLines = priceList
      .map((item) => `- ${item.item_name}: ${item.price_amount} ${item.currency}${item.description ? ` — ${item.description}` : ""}`)
      .join("\n");
    priceListSection = `

PRICE LIST (the ONLY prices you may quote — never invent, discount, or guess a price):
${priceLines}

You may quote and sell these items at exactly these prices. If a customer explicitly agrees to buy one, call close_sale with the exact item_name. Never call close_sale for anything not on this list, and never tell a customer a sale or payment is confirmed yourself — that confirmation is handled automatically once real payment is received.`;
  }

  return `${business.system_prompt_extra}

KNOWLEDGE BASE:
${kbLines}${priceListSection}`;
}

/** Checks if a message should be escalated to a human. */
export function shouldEscalate(business, messageText) {
  const lower = messageText.toLowerCase();
  return business.escalation_keywords.some((keyword) =>
    lower.includes(keyword.toLowerCase())
  );
}

/**
 * Generate a reply for one chat turn using whichever AI provider this
 * business has configured. Returns any capture_lead and close_sale tool
 * calls the AI made — the caller (index.js) is responsible for verifying
 * close_sale's item_name against the real price list before acting on it.
 * @param {number} businessId
 * @param {Array<{role: "user"|"assistant", content: string}>} history
 * @returns {Promise<{ reply: string, capturedLead: object|null, saleRequest: object|null }>}
 */
export async function generateReply(businessId, history) {
  const business = getBusiness(businessId);
  if (!business) {
    throw new Error(`No business found for business_id=${businessId}. Run seed.js first.`);
  }

  if (!business.ai_api_key_encrypted || !business.ai_provider) {
    console.error(
      `No AI provider configured for business_id=${businessId}. Add one in the admin panel's AI Settings tab.`
    );
    return {
      reply: "Sorry, I'm having trouble responding right now. A team member will follow up shortly.",
      capturedLead: null,
      saleRequest: null,
    };
  }

  try {
    const apiKey = decrypt(business.ai_api_key_encrypted);
    const provider = getProvider(business.ai_provider);
    const priceList = getPriceList(businessId);

    const { text, toolCalls } = await provider.generateReply({
      apiKey,
      model: business.ai_model,
      systemPrompt: buildSystemPrompt(business, priceList),
      history,
      tools: [CAPTURE_LEAD_TOOL, CLOSE_SALE_TOOL],
    });

    const leadCall = toolCalls.find((tc) => tc.name === "capture_lead");
    const saleCall = toolCalls.find((tc) => tc.name === "close_sale");

    return {
      reply: text || "Thanks — I've passed your details to our team, they'll follow up shortly.",
      capturedLead: leadCall ? leadCall.input : null,
      saleRequest: saleCall ? saleCall.input : null,
    };
  } catch (err) {
    console.error("AI provider error:", err.message);
    return {
      reply: "Sorry, I'm having trouble responding right now. A team member will follow up shortly.",
      capturedLead: null,
      saleRequest: null,
    };
  }
}
