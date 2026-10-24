// providers/openai.js
// Adapter for OpenAI (GPT) models. Translates the shared tool schema into
// OpenAI's function-calling format and translates its response back into
// the shared { text, toolCalls } shape.

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

export async function generateReply({ apiKey, model, systemPrompt, history, tools }) {
  const client = new OpenAI({ apiKey });

  const messages = [{ role: "system", content: systemPrompt }, ...history];

  const response = await client.chat.completions.create({
    model: model || "gpt-5.6",
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

export async function testConnection({ apiKey, model }) {
  const client = new OpenAI({ apiKey });
  await client.chat.completions.create({
    model: model || "gpt-5.6",
    max_tokens: 10,
    messages: [{ role: "user", content: "Reply with just: OK" }],
  });
  return true;
}
