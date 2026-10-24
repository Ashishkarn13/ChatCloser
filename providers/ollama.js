// providers/ollama.js
// Local model runtime (Ollama) and any other OpenAI-compatible server that
// runs on the machine itself.
//
// This is the "local-only" path: the business can run ChatCloser with no
// conversation data ever leaving the computer. Ollama exposes an
// OpenAI-compatible API, so the shared factory works unchanged.
//
// Ollama does not require an API key; the placeholder below is ignored by
// the server but the OpenAI client insists on a non-empty string.

import { createOpenAICompatibleProvider } from "./openai-compatible.js";

const DEFAULT_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1";

export const { generateReply, testConnection } = createOpenAICompatibleProvider({
  baseURL: DEFAULT_BASE_URL,
});

/** Ollama's own API lists the models that are pulled locally. */
export async function listLocalModels() {
  const base = DEFAULT_BASE_URL.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return (body.models || []).map((m) => ({
      id: m.name,
      sizeBytes: m.size,
      modifiedAt: m.modified_at,
    }));
  } catch (err) {
    throw new Error(`Could not reach the local model runtime at ${base}: ${err.message}`);
  }
}

/** True when the local runtime is reachable. */
export async function healthCheck() {
  try {
    await listLocalModels();
    return { ok: true, baseUrl: DEFAULT_BASE_URL };
  } catch (err) {
    return { ok: false, baseUrl: DEFAULT_BASE_URL, error: err.message };
  }
}
