// providers/anthropic.js
// Adapter for Anthropic (Claude) models. Same interface as every other
// provider adapter: generateReply() and testConnection().

import Anthropic from "@anthropic-ai/sdk";

export async function generateReply({ apiKey, model, systemPrompt, history, tools }) {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: model || "claude-sonnet-5",
    max_tokens: 500,
    system: systemPrompt,
    tools: tools || [],
    messages: history,
  });

  let text = "";
  const toolCalls = [];
  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({ name: block.name, input: block.input });
    }
  }

  return {
    text: text.trim(),
    toolCalls,
    usage: {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
    },
  };
}

export async function testConnection({ apiKey, model }) {
  const client = new Anthropic({ apiKey });
  await client.messages.create({
    model: model || "claude-sonnet-5",
    max_tokens: 10,
    messages: [{ role: "user", content: "Reply with just: OK" }],
  });
  return true;
}
