// providers/openrouter.js
// OpenRouter is OpenAI-compatible and itself routes to many underlying
// models (including DeepSeek, Llama, Mistral, and others) behind one key
// — pick the specific model in the admin panel's model field, e.g.
// "deepseek/deepseek-chat" or "meta-llama/llama-3.3-70b-instruct".

import { createOpenAICompatibleProvider } from "./openai-compatible.js";

export const { generateReply, testConnection } = createOpenAICompatibleProvider({
  baseURL: "https://openrouter.ai/api/v1",
  // OpenRouter asks for these but doesn't require them to work — they're
  // used for their own analytics/rankings, harmless to include.
  defaultHeaders: {
    "HTTP-Referer": "https://localhost",
    "X-Title": "WhatsApp AI Bot",
  },
});
