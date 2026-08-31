// providers/nvidia.js
// NVIDIA NIM's hosted API is also OpenAI-compatible.

import { createOpenAICompatibleProvider } from "./openai-compatible.js";

export const { generateReply, testConnection } = createOpenAICompatibleProvider({
  baseURL: "https://integrate.api.nvidia.com/v1",
});
