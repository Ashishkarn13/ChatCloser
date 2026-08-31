// providers/groq.js
// Groq is OpenAI-compatible and offers a genuinely free tier — no credit
// card required, rate-limited rather than credit-limited. Runs
// open-weight models (Llama, Qwen, OpenAI's open gpt-oss line) on their
// own custom inference hardware, not proprietary models like GPT/Claude/
// Gemini.
//
// NOTE: Groq deprecated llama-3.3-70b-versatile and llama-3.1-8b-instant
// (shutdown Aug 16, 2026) — do not reintroduce those as defaults. Current
// recommended models are the openai/gpt-oss-* line below.

import { createOpenAICompatibleProvider } from "./openai-compatible.js";

export const { generateReply, testConnection } = createOpenAICompatibleProvider({
  baseURL: "https://api.groq.com/openai/v1",
});
