// providers/deepseek.js
// DeepSeek's API is OpenAI-compatible — this just points the shared
// factory at their endpoint.

import { createOpenAICompatibleProvider } from "./openai-compatible.js";

export const { generateReply, testConnection } = createOpenAICompatibleProvider({
  baseURL: "https://api.deepseek.com/v1",
});
