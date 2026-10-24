// src/services/ai/model-adapter.js
// Provider-independent model access.
//
// Everything the AI engine needs from a model goes through here:
//
//   * timeouts and bounded retries
//   * an optional fallback model when the primary one fails
//   * health checks that the settings screen can call
//   * token usage and an estimated cost, written to the ai_runs ledger
//   * a "local only" mode in which conversation data is never sent to a
//     cloud provider
//
// The provider adapters in /providers are unchanged in shape; this module
// adds the operational behaviour around them.

import { getProvider, SUPPORTED_PROVIDERS } from "../../../providers/index.js";
import { getBusinessConfig } from "../businesses.js";
import { decrypt } from "../../../crypto-utils.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_TOKENS = 500;

/**
 * Approximate list prices in USD per 1,000,000 tokens.
 * These are ESTIMATES used only for the cost dashboard — they drift and
 * they are not a billing source of truth. A business can override them in
 * its settings (settings.modelPricing).
 */
const APPROXIMATE_PRICING = {
  anthropic: { input: 3, output: 15 },
  openai: { input: 2.5, output: 10 },
  google: { input: 0.3, output: 2.5 },
  deepseek: { input: 0.3, output: 1.5 },
  openrouter: { input: 1, output: 3 },
  nvidia: { input: 0.2, output: 0.6 },
  groq: { input: 0.3, output: 0.5 },
  ollama: { input: 0, output: 0 },
};

export class ModelError extends Error {
  constructor(message, { code = "model_error", retryable = false, cause = null } = {}) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/** Providers that run on the machine itself. */
export const LOCAL_PROVIDERS = ["ollama"];

export function isLocalProvider(provider) {
  return LOCAL_PROVIDERS.includes(String(provider || "").toLowerCase());
}

/**
 * Reads the model's credentials for a business.
 * @returns {{provider: string, model: string, apiKey: string, local: boolean}}
 */
export function resolveModel(businessId) {
  const business = getBusinessConfig(businessId);
  const provider = String(business.ai_provider || "").toLowerCase();
  const model = business.ai_model || "";

  let apiKey = "";
  if (business.ai_api_key_encrypted) {
    try {
      apiKey = decrypt(business.ai_api_key_encrypted);
    } catch {
      apiKey = "";
    }
  }

  // A local runtime needs no key, but the OpenAI-compatible client still
  // insists on a non-empty string.
  if (!apiKey && isLocalProvider(provider)) {
    apiKey = "local";
  }

  return { provider, model, apiKey, local: isLocalProvider(provider) };
}

/**
 * Refuses to send anything to a cloud provider when the business has
 * enabled local-only mode.
 */
export function assertProviderAllowed(business, provider) {
  if (!business.ai_local_only) return;
  if (isLocalProvider(provider)) return;
  throw new ModelError(
    `This workspace is configured to keep customer data on this computer, so "${provider}" cannot be used. Switch the AI configuration back to a local model, or turn off local-only mode if you intend to use a cloud provider.`,
    { code: "provider_not_allowed" }
  );
}

function estimateCost(business, provider, usage) {
  const override = business.settings?.modelPricing?.[provider];
  const pricing = override || APPROXIMATE_PRICING[provider] || { input: 0, output: 0 };
  const prompt = (Number(usage?.promptTokens || 0) / 1_000_000) * Number(pricing.input || 0);
  const completion = (Number(usage?.completionTokens || 0) / 1_000_000) * Number(pricing.output || 0);
  return Math.round((prompt + completion) * 1e6) / 1e6;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ModelError(`${label} timed out after ${ms}ms.`, { code: "timeout", retryable: true })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isRetryable(err) {
  if (err instanceof ModelError) return err.retryable;
  const message = String(err?.message || "").toLowerCase();
  return (
    /timeout|timed out|network|econn|socket hang up|429|rate limit|5\d\d|overloaded|fetch failed/.test(
      message
    )
  );
}

/**
 * Calls a model, with retries and an optional fallback.
 *
 * @param {object} params
 * @param {number} params.businessId
 * @param {string} params.systemPrompt
 * @param {Array<{role:string, content:string}>} params.history
 * @param {Array<object>} [params.tools]
 * @returns {Promise<{text:string, toolCalls:Array, usage:object, latencyMs:number, provider:string, model:string, fallbackUsed:boolean, estimatedCost:number}>}
 */
export async function callModel({
  businessId,
  systemPrompt,
  history,
  tools = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  useFallback = true,
  temperature,
  maxTokens,
}) {
  const business = getBusinessConfig(businessId);
  const primary = resolveModel(businessId);

  if (!primary.provider) {
    throw new ModelError("No AI provider is configured for this workspace.", { code: "not_configured" });
  }
  assertProviderAllowed(business, primary.provider);

  const attempts = [];
  const candidates = [primary];

  if (useFallback && business.ai_fallback_provider) {
    let fallbackKey = "";
    if (business.ai_fallback_provider !== primary.provider && business.ai_api_key_encrypted) {
      try {
        fallbackKey = decrypt(business.ai_api_key_encrypted);
      } catch {
        fallbackKey = "";
      }
    }
    if (!fallbackKey && isLocalProvider(business.ai_fallback_provider)) fallbackKey = "local";
    candidates.push({
      provider: String(business.ai_fallback_provider).toLowerCase(),
      model: business.ai_fallback_model || "",
      apiKey: fallbackKey,
      local: isLocalProvider(business.ai_fallback_provider),
    });
  }

  let lastError = null;

  for (let c = 0; c < candidates.length; c += 1) {
    const candidate = candidates[c];
    const isFallback = c > 0;

    try {
      assertProviderAllowed(business, candidate.provider);
      const adapter = getProvider(candidate.provider);
      const model = candidate.model || adapter.defaultModel || "";

      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const startedAt = Date.now();
        try {
          const result = await withTimeout(
            adapter.generateReply({
              apiKey: candidate.apiKey || "local",
              model,
              systemPrompt,
              history,
              tools,
              temperature: temperature ?? business.ai_temperature ?? 0.4,
              maxTokens: maxTokens ?? business.ai_max_tokens ?? DEFAULT_MAX_TOKENS,
            }),
            timeoutMs,
            `${candidate.provider}/${model}`
          );

          const usage = {
            promptTokens: result.usage?.promptTokens ?? 0,
            completionTokens: result.usage?.completionTokens ?? 0,
          };

          return {
            text: result.text || "",
            toolCalls: result.toolCalls || [],
            usage,
            latencyMs: Date.now() - startedAt,
            provider: candidate.provider,
            model,
            fallbackUsed: isFallback,
            estimatedCost: estimateCost(business, candidate.provider, usage),
            attempts: attempt + 1,
          };
        } catch (err) {
          lastError = err;
          attempt += 1;
          if (!isRetryable(err) || attempt > retries) break;
          // Linear backoff with a small jitter so a rate-limited provider
          // is not hammered by every conversation at once.
          const delay = Math.min(4000, 500 * attempt) + Math.floor(Math.random() * 250);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    } catch (err) {
      lastError = err;
      attempts.push({ provider: candidate.provider, error: err.message });
    }
  }

  throw new ModelError(
    `All configured models failed: ${lastError?.message || "unknown error"}`,
    { code: "all_providers_failed", cause: lastError }
  );
}

/**
 * Health check for the settings screen.
 * @returns {Promise<{ok:boolean, model?:string, error?:string}>}
 */
export async function testModel({ businessId, provider, model, apiKey }) {
  try {
    const business = getBusinessConfig(businessId);
    let resolvedProvider = provider || resolveModel(businessId).provider;
    let resolvedModel = model;
    let key = apiKey;

    if (!key) {
      const resolved = resolveModel(businessId);
      key = resolved.apiKey;
      resolvedProvider = resolvedProvider || resolved.provider;
      resolvedModel = resolvedModel || resolved.model;
    }
    if (!key && isLocalProvider(resolvedProvider)) key = "local";

    if (!resolvedProvider) throw new Error("Choose a provider first.");

    const meta = SUPPORTED_PROVIDERS.find((p) => p.id === resolvedProvider);
    if (meta && resolvedModel && !meta.models.includes(resolvedModel)) {
      resolvedModel = resolvedModel || meta.defaultModel;
    }
    if (!resolvedModel && meta) resolvedModel = meta.defaultModel;

    assertProviderAllowed(business, resolvedProvider);

    const adapter = getProvider(resolvedProvider);
    await adapter.testConnection({ apiKey: key || "", model: resolvedModel });

    return { ok: true, provider: resolvedProvider, model: resolvedModel };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Health check for the local runtime. */
export async function localRuntimeHealth() {
  try {
    const { healthCheck } = await import("../../../providers/ollama.js");
    return await healthCheck();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export { APPROXIMATE_PRICING, SUPPORTED_PROVIDERS };
