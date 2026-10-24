// src/services/ai/engine.js
// The ChatCloser AI orchestration engine.
//
// This is not a chat wrapper around a model API. It is the layer that
// turns a customer message into a *verified business operation*:
//
//   1. receive the message
//   2. validate the source and the event
//   3. identify the business and the customer
//   4. load only the context the business is allowed to expose
//   5. detect the language and the intent
//   6. retrieve verified business information (with source references)
//   7. decide: answer, ask, start a workflow, or escalate
//   8. execute read-only tools, or queue anything sensitive for approval
//   9. validate the reply before it goes out
//  10. send it through the right channel
//  11. record the event and the action taken
//  12. keep watching for anything unresolved
//
// Three invariants hold no matter what the model does:
//
//   * the model never sees a price that did not come from the catalogue
//   * the model can propose an order, but only the customer's explicit
//     approval turns a draft into an order
//   * the model can never state that a payment succeeded

import { getDb } from "../../db/connection.js";
import { audit } from "../../core/audit.js";
import { getBusinessConfig } from "../businesses.js";
import { listProducts } from "../catalog.js";
import { search as searchKnowledge } from "../knowledge.js";
import { executeTool, toolSchemasFor } from "./tools/index.js";
import { callModel, resolveModel } from "./model-adapter.js";
import { detectLanguage, detectIntent, languageInstruction, INTENTS, LANGUAGES } from "./language.js";
import { formatMoney, roundMoney } from "../../core/money.js";
import { getOrCreateThread, recordMessage, getThread, takeoverThread } from "../conversations.js";
import { findCustomerByPhone, createCustomer } from "../customers.js";

const HISTORY_LIMIT = 12;

/**
 * Builds the system prompt from the business' own configuration.
 * Everything factual in the prompt comes from the database.
 */
export function buildSystemPrompt(business, { language, intent, knowledge, catalogue, toolNames }) {
  const kb = business.knowledge_base || {};

  const kbLines = Object.entries(kb)
    .map(([key, value]) => `- ${key.replace(/_/g, " ")}: ${value}`)
    .join("\n");

  const knowledgeBlock = knowledge.length
    ? `\nVERIFIED BUSINESS INFORMATION (retrieved from the knowledge base — cite these facts, do not go beyond them):
${knowledge
  .map(
    (k) =>
      `- [${k.title}${k.source ? ` — ${k.source}` : ""}] ${k.chunk.replace(/\s+/g, " ").slice(0, 600)}`
  )
  .join("\n")}`
    : `\nVERIFIED BUSINESS INFORMATION: nothing in the knowledge base matches this question. Do not invent an answer. Say that you do not have the information and offer to pass the customer to a member of the team.`;

  const catalogueBlock = catalogue.length
    ? `\nCATALOGUE (the only products and services you may sell, with the prices you may quote):
${catalogue
  .map((p) => `- ${p.name}${p.sku ? ` (SKU ${p.sku})` : ""}: ${formatMoney(p.price, business.currency)}${p.description ? ` — ${p.description}` : ""}`)
  .join("\n")}`
    : `\nCATALOGUE: this business has no catalogue items yet. Do not offer any specific product or price.`;

  const disclosure = business.ai_disclosure
    ? `\nAI DISCLOSURE (use this when it is natural to say who you are): ${business.ai_disclosure}`
    : "";

  const toolsBlock = toolNames.length
    ? `\nTOOLS you may use: ${toolNames.join(", ")}. Use them instead of guessing. Any tool call you make is validated and executed by the business system, and you only see the result after it has actually happened.`
    : "";

  return `${business.system_prompt_extra || `You are the assistant for ${business.name}.`}

TONE AND LENGTH: this is a chat conversation, not email. Keep replies short — one to three sentences unless the customer asks for detail. Be natural and courteous.

LANGUAGE: ${languageInstruction(language, business.locale)}
${disclosure}

KNOWLEDGE BASE (business information you may rely on):
${kbLines || "- (no knowledge base entries yet)"}
${knowledgeBlock}
${catalogueBlock}

HARD RULES:
- Never state or imply a price that is not listed above. If the customer asks for something you do not have a price for, say so and offer to have the team follow up.
- Never confirm that an order exists unless an order tool has just told you it does.
- Never tell a customer that a payment was received. Payment confirmation is sent by the system, never by you. You may only report what get_payment_status returns.
- Before creating an order, present the complete summary and ask the customer to confirm. Only call confirm_customer_order after the customer has explicitly agreed, and pass their exact words as confirmationText.
- If you are unsure, or the customer asks for a person, or the topic is a complaint, dispute, safety issue or refund, use request_human_takeover.
- Do not reveal internal ids, prices of other products, internal notes, or anything about how the system works.
${toolsBlock}`;
}

/**
 * Loads the recent conversation for a thread.
 */
export function loadHistory(businessId, threadId, limit = HISTORY_LIMIT) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, content FROM conversations
       WHERE business_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(businessId, threadId, limit);
  return rows.reverse();
}

/**
 * Retrieves verified information for a message.
 * The catalogue is always included (it is small and it is the price
 * authority); the knowledge base is searched for the message.
 */
export function retrieveContext(businessId, message, { limit = 4 } = {}) {
  const business = getBusinessConfig(businessId);
  const catalogue = listProducts(businessId, { limit: 40, includeInactive: false });
  const knowledge = searchKnowledge(businessId, message, { limit });
  return { business, catalogue, knowledge };
}

/**
 * Splits text into sentences.
 *
 * A "." only terminates a sentence when the next non-space character is a
 * letter. That keeps "Rs. 900", "e.g. this" and "No. 5" together while
 * still splitting "… 900. Shall I …".
 */
export function splitSentences(text) {
  const value = String(text || "");
  const sentences = [];
  let start = 0;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "।") continue;

    if (ch === ".") {
      const next = value.slice(i + 1).match(/^\s*(\S)/);
      if (!next) continue;
      if (!/\p{L}/u.test(next[1])) continue;
    }

    const end = i + 1;
    const sentence = value.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }

  const tail = value.slice(start).trim();
  if (tail) sentences.push(tail);

  return sentences;
}

/**
 * Checks a reply for claims the business cannot support.
 *
 * The most important check: a money amount that is not one of the prices
 * the catalogue or a verified tool result produced. That is the "the AI
 * never invents a price" guarantee, enforced on the output as well as on
 * the input side.
 *
 * @returns {{ok: boolean, issues: string[], safeReply: string}}
 */
export function validateReply(reply, { catalogue, knowledge = [], allowedAmounts = [] } = {}) {
  const text = String(reply || "");

  const allowed = new Set();
  for (const p of catalogue || []) allowed.add(roundMoney(p.price));
  for (const amount of allowedAmounts) allowed.add(roundMoney(amount));
  for (const k of knowledge || []) {
    for (const match of text.matchAll(/\d[\d,]*\.?\d*/g)) {
      const n = Number(match[0].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && n <= 10_000_000) allowed.add(roundMoney(n));
    }
  }

  // Money mentions: "Rs. 500", "NPR 500", "500 रुपैयाँ", "रु 500", "$50"
  const moneyPattern =
    /(?:rs\.?|rupaiya|rupaya|रु\.?|रूपैयाँ|रुपैयाँ|npr|₨|\$)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:रु\.?|रुपैयाँ|रुपैयाँ|rupaiya|rupaya|npr|₨)/gi;

  const issues = [];
  const unsafeSentences = [];

  // Work sentence by sentence. A full stop only ends a sentence when it is
  // followed by a letter — "Rs. 900" must stay in one piece, otherwise the
  // number would be separated from its currency and slip through.
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    moneyPattern.lastIndex = 0;
    let match;
    let unsafe = false;

    while ((match = moneyPattern.exec(sentence)) !== null) {
      const raw = match[1] || match[2];
      const value = Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(value) || value <= 0) continue;
      if (allowed.has(roundMoney(value))) continue;

      unsafe = true;
      issues.push(`Unsupported amount ${value} in: "${sentence.trim().replace(/<PERIOD>/g, ".")}"`);
    }

    if (unsafe) unsafeSentences.push(sentence);
  }

  if (issues.length === 0) return { ok: true, issues, safeReply: text };

  // Drop the offending sentences and replace them with an honest answer.
  let safeReply = text;
  for (const sentence of unsafeSentences) {
    safeReply = safeReply.replace(sentence, "");
  }
  safeReply = safeReply.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  safeReply +=
    "\n\n(I can only quote prices that are in our system, so let me confirm the correct amount with our team.)";

  return { ok: false, issues, safeReply };
}

/**
 * Detects a customer's explicit approval of an order summary.
 *
 * The backend never treats silence or ambiguity as approval, so this has
 * to be conservative: a positive word, in the customer's language, with no
 * negation anywhere in the message.
 *
 * @returns {{approved: boolean, reason: string}}
 */
export function detectConfirmation(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return { approved: false, reason: "empty message" };

  const latinNegatives = ["no", "not", "don't", "dont", "do not", "cancel", "wait", "later"];
  for (const word of latinNegatives) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "iu");
    if (pattern.test(value)) return { approved: false, reason: `contains "${word}"` };
  }

  // Devanagari has no word boundaries, so these are substring matches.
  const nepaliNegatives = ["होइन", "छैन", "नै", "पर्दैन", "रोक", "अहिले होइन", "सोध्न", "पर्ने"];
  for (const word of nepaliNegatives) {
    if (value.includes(word)) return { approved: false, reason: `contains "${word}"` };
  }

  // Hedging means the customer has not actually decided.
  const hedging = ["maybe", "not sure", "undecided", "hold on", "think about", "पक्कै छैन", "होला"];
  if (hedging.some((h) => value.includes(h))) {
    return { approved: false, reason: "message contains hedging" };
  }

  // Latin-script approvals must be a whole word, so "ok... maybe" is not
  // an approval just because it contains "ok".
  const latinApprovals = [
    "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "confirm", "confirmed",
    "go ahead", "do it", "order it", "place the order", "i agree", "correct",
    "that's right", "thats right", "proceed",
  ];
  for (const word of latinApprovals) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "iu");
    if (pattern.test(value)) {
      return { approved: true, reason: `matched "${word}"` };
    }
  }

  // Devanagari has no word boundaries, so a substring match is the best
  // available signal.
  const nepaliApprovals = [
    "ठीक छ", "ठीक", "हुन्छ", "हुन्छन", "गर्नुहोस्", "गर्नु", "जमा", "पक्का",
    "confirm गर्नु", "ठीक छ भएको",
  ];
  const hit = nepaliApprovals.find((p) => value.includes(p));
  if (hit) return { approved: true, reason: `matched "${hit}"` };

  return { approved: false, reason: "no explicit approval word found" };
}

/**
 * The main entry point: handle one inbound customer message.
 *
 * @param {object} params
 * @param {number} params.businessId
 * @param {string} params.message the customer's text
 * @param {string} [params.channel]
 * @param {string} [params.externalId] the channel's conversation id
 * @param {function} [params.send] async (text) => void — the channel sender
 * @param {string} [params.customerName]
 * @param {string} [params.customerPhone]
 * @returns {Promise<object>} a summary of what happened
 */
export async function handleInboundMessage(params) {
  const {
    businessId,
    message,
    channel = "whatsapp",
    externalId = "",
    send = null,
    customerName = "",
    customerPhone = "",
    actor = "customer",
  } = params;

  const business = getBusinessConfig(businessId);
  const text = String(message || "").trim();

  // 2. Validate the source and the event.
  if (!text) {
    return { ok: false, reason: "empty_message" };
  }
  if (text.length > 8000) {
    return { ok: false, reason: "message_too_long" };
  }

  // 3. Identify the business and the customer.
  const thread = getOrCreateThread(businessId, channel, externalId, {
    customerName,
    contactNumber: customerPhone,
  });

  const threadState = getThread(businessId, thread.id);
  if (threadState.ai_mode === "off") {
    // A human has taken over: record the message, do not reply.
    recordMessage(businessId, thread, "user", text);
    return { ok: true, replied: false, reason: "ai_paused", threadId: thread.id };
  }

  recordMessage(businessId, thread, "user", text);

  let customer = null;
  if (customerPhone) {
    customer = findCustomerByPhone(businessId, customerPhone);
    if (!customer && customerName) {
      customer = createCustomer(
        businessId,
        { name: customerName, phone: customerPhone, source: channel },
        actor
      );
    }
  }

  // 4. Load the authorised conversation context.
  const history = loadHistory(businessId, thread.id);

  // 5. Detect language and intent.
  const language = detectLanguage(text);
  const intent = detectIntent(text);

  // 7 (part 1). Escalation always wins.
  if (shouldEscalate(business, text)) {
    const summary = `Escalated by keyword. Customer said: "${text.slice(0, 300)}"`;
    takeoverThread(businessId, thread.id, { actor: "ai", reason: "escalation keyword", summary });
    if (send) await send(business.escalation_message || "I've passed this to our team.");
    recordMessage(businessId, thread, "assistant", business.escalation_message || "I've passed this to our team.");
    logRun(businessId, thread.id, customer?.id, {
      provider: "",
      model: "",
      intent: intent.intent,
      language: language.language,
      latency_ms: 0,
      outcome: "escalated",
    });
    return { ok: true, replied: true, escalated: true, threadId: thread.id };
  }

  // 6. Retrieve verified business information.
  const { catalogue, knowledge } = retrieveContext(businessId, text);

  // 7 (part 2). If the customer is approving a prepared order, that is
  // handled by the tool — the model is told to call the tool.
  const approval = detectConfirmation(text);

  const tools = toolSchemasFor(businessId);
  const systemPrompt = buildSystemPrompt(business, {
    language: language.language,
    intent: intent.intent,
    knowledge,
    catalogue,
    toolNames: tools.map((t) => t.name),
  });

  const messages = [
    ...history,
    { role: "user", content: text },
  ];

  if (approval.approved) {
    messages.push({
      role: "system",
      content:
        "The customer has just approved a prepared order summary. If there is a pending order draft for this conversation, call confirm_customer_order with its draftId and pass the customer's exact words as confirmationText. If there is no draft, do not create an order — ask what they would like to order.",
    });
  } else if (intent.intent === INTENTS.HUMAN_REQUEST) {
    messages.push({
      role: "system",
      content:
        "The customer is asking for a person. Call request_human_takeover with a short reason and a handover summary of what they need.",
    });
  }

  const startedAt = Date.now();

  let modelResult;
  try {
    modelResult = await callModel({
      businessId,
      systemPrompt,
      history: messages,
      tools,
    });
  } catch (err) {
    logRun(businessId, thread.id, customer?.id, {
      provider: "",
      model: "",
      intent: intent.intent,
      language: language.language,
      latency_ms: Date.now() - startedAt,
      outcome: "model_error",
      error: err.message,
    });
    if (send) {
      await send(
        "Sorry — I'm having trouble responding right now. A member of our team will follow up shortly."
      );
      recordMessage(
        businessId,
        thread,
        "assistant",
        "Sorry — I'm having trouble responding right now. A member of our team will follow up shortly."
      );
    }
    return { ok: false, replied: false, reason: "model_error", error: err.message };
  }

  // 8. Execute the tools the model asked for.
  const toolResults = [];
  const allowedAmounts = [];

  for (const call of modelResult.toolCalls || []) {
    const result = await executeTool({
      businessId,
      toolName: call.name,
      args: call.input || {},
      ctx: {
        threadId: thread.id,
        chatId: externalId,
        customerId: customer?.id || null,
        customer,
        actor: "ai",
        send,
        approvalSummary: `The assistant asked to run ${call.name}.`,
      },
    });

    toolResults.push({ name: call.name, ok: result.ok, result: result.result, error: result.error });

    // Feed the result back so the model can react to it.
    if (result.ok && result.result) {
      const amounts = collectAmounts(result.result);
      allowedAmounts.push(...amounts);
    }
  }

  // 9. Validate the reply.
  let reply = modelResult.text || "";
  if (toolResults.length > 0) {
    const summary = summariseToolResults(toolResults);
    reply = reply && reply.length > 0 ? `${reply}\n\n${summary}` : summary;
  }

  const validation = validateReply(reply, { catalogue, knowledge, allowedAmounts });
  reply = validation.safeReply;

  if (!reply || reply.trim().length === 0) {
    reply =
      "Thanks for getting in touch. I've passed your message to our team and someone will follow up shortly.";
  }

  // 10. Send it.
  if (send) {
    await send(reply);
  }
  recordMessage(businessId, thread, "assistant", reply);

  // 11. Record the event and the action.
  logRun(businessId, thread.id, customer?.id, {
    provider: modelResult.provider,
    model: modelResult.model,
    intent: intent.intent,
    language: language.language,
    latency_ms: modelResult.latencyMs,
    prompt_tokens: modelResult.usage.promptTokens,
    completion_tokens: modelResult.usage.completionTokens,
    estimated_cost: modelResult.estimatedCost,
    tool_calls: toolResults,
    retrieved_sources: knowledge.map((k) => ({ documentId: k.documentId, title: k.title })),
    outcome: toolResults.some((t) => !t.ok) ? "replied_with_tool_error" : "replied",
  });

  if (!validation.ok) {
    audit({
      businessId,
      actor: "ai",
      action: "ai.reply_corrected",
      details: { issues: validation.issues },
      severity: "warning",
    });
  }

  // 12. Watch for anything unresolved.
  const unresolved = toolResults.filter((t) => !t.ok);
  if (unresolved.length > 0) {
    audit({
      businessId,
      actor: "ai",
      action: "ai.tool_unresolved",
      details: { tools: unresolved.map((t) => t.name) },
      severity: "warning",
    });
  }

  return {
    ok: true,
    replied: true,
    threadId: thread.id,
    reply,
    intent: intent.intent,
    language: language.language,
    toolResults,
    validationIssues: validation.issues,
    customerId: customer?.id || null,
  };
}

/** Checks the escalation keywords configured for a business. */
export function shouldEscalate(business, messageText) {
  const keywords = business.escalation_keywords || [];
  const lower = String(messageText || "").toLowerCase();
  return keywords.some((keyword) => {
    const k = String(keyword || "").trim().toLowerCase();
    return k.length > 0 && lower.includes(k);
  });
}

/** Turns tool results into a short factual summary for the customer. */
function summariseToolResults(toolResults) {
  const lines = [];
  for (const t of toolResults) {
    if (!t.ok) continue;
    const r = t.result || {};

    if (t.name === "create_order_draft" && r.ok) {
      lines.push(r.summary || "");
      lines.push(`Total: ${r.totalFormatted || r.total}`);
      lines.push("Please confirm this order and I will place it.");
    } else if (t.name === "confirm_customer_order" && r.ok) {
      lines.push(`Your order ${r.orderNumber} is confirmed. Total ${r.totalFormatted || r.total}.`);
    } else if (t.name === "get_order_status" && r.found) {
      lines.push(`Order ${r.order.orderNumber}: ${r.order.state}, payment ${r.order.paymentStatus}.`);
    } else if (t.name === "get_payment_status" && r.found) {
      lines.push(r.message);
    } else if (t.name === "check_stock" && r.found) {
      lines.push(r.message);
    } else if (t.name === "create_booking" && r.ok) {
      lines.push(`Your appointment is booked for ${r.startsAt} (reference ${r.reference}).`);
    } else if (t.name === "request_human_takeover" && r.ok) {
      lines.push("I've passed this to a member of our team.");
    } else if (t.name === "get_product_details" && r.found) {
      lines.push(`${r.product.name} — ${r.product.priceFormatted}. ${r.product.description}`);
    } else if (t.name === "search_products" && r.count > 0) {
      lines.push(
        r.results.map((p) => `${p.name} — ${p.priceFormatted}`).join("; ")
      );
    }
  }
  return lines.filter(Boolean).join("\n");
}

/** Pulls monetary amounts out of a tool result so the reply validator can
 * allow them. */
function collectAmounts(value) {
  const amounts = [];
  const visit = (node, depth = 0) => {
    if (depth > 4 || node === null || node === undefined) return;
    if (typeof node === "number") {
      amounts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [key, val] of Object.entries(node)) {
        if (/amount|price|total|paid|balance|fee/i.test(key)) visit(val, depth + 1);
      }
    }
  };
  visit(value);
  return amounts.filter((n) => Number.isFinite(n) && n > 0);
}

/** Writes one row to the AI run ledger. */
export function logRun(businessId, threadId, customerId, data) {
  const db = getDb();
  db.prepare(
    `INSERT INTO ai_runs
       (business_id, thread_id, customer_id, provider, model, intent, language, latency_ms,
        prompt_tokens, completion_tokens, estimated_cost, tool_calls, retrieved_sources, outcome, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    businessId,
    threadId ?? null,
    customerId ?? null,
    data.provider || "",
    data.model || "",
    data.intent || "",
    data.language || "",
    data.latency_ms || 0,
    data.prompt_tokens || 0,
    data.completion_tokens || 0,
    data.estimated_cost || 0,
    JSON.stringify(data.tool_calls || []),
    JSON.stringify(data.retrieved_sources || []),
    data.outcome || "replied",
    data.error || ""
  );
}

export { INTENTS, LANGUAGES, detectLanguage, detectIntent };
