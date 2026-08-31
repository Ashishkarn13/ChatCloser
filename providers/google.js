// providers/google.js
// Adapter for Google (Gemini) models. Translates the shared tool schema
// into Gemini's functionDeclarations format and its response back into
// the shared { text, toolCalls } shape.

import { GoogleGenerativeAI } from "@google/generative-ai";

function toGoogleTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      })),
    },
  ];
}

export async function generateReply({ apiKey, model, systemPrompt, history, tools }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({
    model: model || "gemini-3.6-flash",
    systemInstruction: systemPrompt,
    tools: toGoogleTools(tools),
  });

  const priorHistory = history.slice(0, -1).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const lastMessage = history[history.length - 1];

  const chat = genModel.startChat({ history: priorHistory });
  const result = await chat.sendMessage(lastMessage.content);
  const response = result.response;

  const text = response.text() || "";
  const functionCalls = response.functionCalls() || [];
  const toolCalls = functionCalls.map((fc) => ({ name: fc.name, input: fc.args }));

  return { text: text.trim(), toolCalls };
}

export async function testConnection({ apiKey, model }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model: model || "gemini-3.6-flash" });
  await genModel.generateContent("Reply with just: OK");
  return true;
}
