// providers/index.js
// Registry of supported AI providers. Adding a new provider later means
// adding one adapter file and one entry here — nothing else in the app
// needs to change.
//
// Model lists verified against first-party/current sources as of
// Aug 2026 — these lists WILL go stale over time as providers ship new
// models and retire old ones (this project already hit that once with
// Gemini 2.5 and DeepSeek's old chat/reasoner aliases). If a model in
// this list starts failing, check the provider's own docs before
// assuming it's a bug in this code.

import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";
import * as google from "./google.js";
import * as deepseek from "./deepseek.js";
import * as openrouter from "./openrouter.js";
import * as nvidia from "./nvidia.js";
import * as groq from "./groq.js";

const registry = { anthropic, openai, google, deepseek, openrouter, nvidia, groq };

export function getProvider(name) {
  const provider = registry[name];
  if (!provider) {
    throw new Error(`Unsupported AI provider: "${name}". Supported: ${Object.keys(registry).join(", ")}`);
  }
  return provider;
}

export const SUPPORTED_PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-4-8", "claude-fable-5", "claude-haiku-4-5-20251001"],
    freeTier: false,
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    defaultModel: "gpt-5.6",
    models: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
    freeTier: false,
  },
  {
    id: "google",
    label: "Google (Gemini) — has a free tier",
    defaultModel: "gemini-3.6-flash",
    models: ["gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
    freeTier: true,
    freeTierNote: "Google AI Studio issues free API keys with a rate-limited free quota — no card required to start.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    freeTier: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter (many models, one key)",
    defaultModel: "meta-llama/llama-3.3-70b-instruct",
    models: [
      "meta-llama/llama-3.3-70b-instruct",
      "deepseek/deepseek-v4-flash",
      "qwen/qwen3-coder",
      "mistralai/mistral-large",
    ],
    freeTier: true,
    freeTierNote: "OpenRouter hosts rotating \":free\" model variants at $0/token (rate-limited, no card required). Exact free model IDs change often — check openrouter.ai/models?max_price=0 for what's currently free, then paste that exact model string into the Model field below.",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM — has a free tier",
    defaultModel: "nvidia/nemotron-3-ultra-550b-a55b",
    models: ["nvidia/nemotron-3-ultra-550b-a55b", "meta/llama-3.1-70b-instruct"],
    freeTier: true,
    freeTierNote: "build.nvidia.com issues a free API key with starter credits — no card required to start.",
  },
  {
    id: "groq",
    label: "Groq — free tier, no card required",
    defaultModel: "openai/gpt-oss-120b",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"],
    freeTier: true,
    freeTierNote: "Groq's free tier requires no credit card and includes every model — it's rate-limited (not credit-limited), and only runs open-weight models (no GPT/Claude/Gemini).",
  },
];
