// ai.js
// ChatCloser 1.x compatibility shim.
//
// ChatCloser 1.x exposed exactly two functions from this file:
// `generateReply(businessId, history)` and `shouldEscalate(business, text)`.
// Both are kept so that existing integrations keep working, but the work is
// now done by the ChatCloser 2.0 AI engine:
//
//   * the system prompt is built from the catalogue and the searchable
//     knowledge base (src/services/ai/engine.js)
//   * model access goes through the provider-independent adapter with
//     timeouts, retries, fallbacks and usage tracking
//   * the tools are the permission-controlled registry, not two loose
//     function definitions
//
// New code should call handleInboundMessage() in src/services/ai/engine.js
// instead of this file.

import { getBusiness } from "./db.js";
import { getBusinessConfig } from "./src/services/businesses.js";
import { listProducts } from "./src/services/catalog.js";
import { search as searchKnowledge } from "./src/services/knowledge.js";
import { toolSchemasFor } from "./src/services/ai/tools/index.js";
import { callModel } from "./src/services/ai/model-adapter.js";
import { buildSystemPrompt, detectLanguage } from "./src/services/ai/engine.js";

/** Checks if a message should be escalated to a human. */
export function shouldEscalate(business, messageText) {
  const keywords = business?.escalation_keywords || [];
  const lower = String(messageText || "").toLowerCase();
  return keywords.some((keyword) => {
    const k = String(keyword || "").trim().toLowerCase();
    return k.length > 0 && lower.includes(k);
  });
}

/**
 * Generates a reply using the ChatCloser 2.0 engine internals.
 *
 * @param {number} businessId
 * @param {Array<{role: "user"|"assistant", content: string}>} history
 * @returns {Promise<{reply: string, capturedLead: object|null, saleRequest: object|null}>}
 */
export async function generateReply(businessId, history) {
  const business = getBusiness(businessId);
  if (!business) {
    throw new Error(`No business found for business_id=${businessId}.`);
  }

  const config = getBusinessConfig(businessId);
  if (!config.ai_api_key_encrypted || !config.ai_provider) {
    console.error(
      `No AI provider configured for business_id=${businessId}. Add one in the admin panel's AI Settings tab.`
    );
    return {
      reply: "Sorry, I'm having trouble responding right now. A team member will follow up shortly.",
      capturedLead: null,
      saleRequest: null,
    };
  }

  const lastUserMessage = [...(history || [])].reverse().find((m) => m.role === "user")?.content || "";
  const language = detectLanguage(lastUserMessage);

  const catalogue = listProducts(businessId, { limit: 40 });
  const knowledge = lastUserMessage ? searchKnowledge(businessId, lastUserMessage, { limit: 4 }) : [];
  const tools = toolSchemasFor(businessId);

  const systemPrompt = buildSystemPrompt(config, {
    language: language.language,
    intent: "general",
    knowledge,
    catalogue,
    toolNames: tools.map((t) => t.name),
  });

  try {
    const result = await callModel({
      businessId,
      systemPrompt,
      history: history || [],
      tools,
    });

    const leadCall = (result.toolCalls || []).find((tc) => tc.name === "capture_lead");
    const saleCall = (result.toolCalls || []).find((tc) => tc.name === "close_sale");

    return {
      reply: result.text || "Thanks — I've passed your details to our team, they'll follow up shortly.",
      capturedLead: leadCall ? leadCall.input : null,
      saleRequest: saleCall ? saleCall.input : null,
      usage: result.usage,
      provider: result.provider,
      model: result.model,
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
