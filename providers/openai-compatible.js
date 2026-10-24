// providers/openai-compatible.js
// Factory for any provider that speaks the OpenAI chat-completions API
// shape — DeepSeek, OpenRouter, and NVIDIA NIM all do, they just use a
// different base URL. This avoids writing near-identical adapter code
// three times; each provider file below is a thin config wrapper around
// this factory.

import OpenAI from "openai";

function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * @param {object} config
 * @param {string} config.baseURL - the provider's OpenAI-compatible endpoint
 * @param {object} [config.defaultHeaders] - extra headers some providers require (e.g. OpenRouter)
 */
export function createOpenAICompatibleProvider({ baseURL, defaultHeaders }) {
  async function generateReply({ apiKey, model, systemPrompt, history, tools }) {
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    const messages = [{ role: "system", content: systemPrompt }, ...history];

    const response = await client.chat.completions.create({
      model,
      max_tokens: 500,
      messages,
      tools: toOpenAITools(tools),
    });

    const choice = response.choices[0]?.message;
    const text = choice?.content || "";
    const toolCalls = (choice?.tool_calls || []).map((tc) => ({
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || "{}"),
    }));

    return {
      text: text.trim(),
      toolCalls,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async function testConnection({ apiKey, model }) {
    const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    await client.chat.completions.create({
      model,
      max_tokens: 10,
      messages: [{ role: "user", content: "Reply with just: OK" }],
    });
    return true;
  }

  return { generateReply, testConnection };
}
