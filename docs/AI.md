# AI setup

The assistant is a conversation layer around your own data and your own AI
account. Nothing is sent anywhere until you configure a provider.

---

## Providers

Configure in **AI Configuration**. All keys are encrypted with `ENCRYPTION_KEY`
before they are stored, and are never sent back to the browser.

| Provider | Where the key comes from | Notes |
| --- | --- | --- |
| Anthropic | console.anthropic.com | Strongest instruction-following for replies |
| OpenAI | platform.openai.com | |
| Google Gemini | aistudio.google.com | Free keys with a rate-limited quota |
| DeepSeek | platform.deepseek.com | Low cost |
| OpenRouter | openrouter.ai | One key for many models; `:free` variants exist |
| NVIDIA NIM | build.nvidia.com | Starter credits |
| Groq | console.groq.com | Free tier, open-weight models only |
| **Ollama (local)** | none | Runs on your machine; customer data never leaves it |

### Local models (Ollama)

```bash
# install from ollama.com, then:
ollama serve
ollama pull qwen2.5:7b
```

In AI Configuration choose **Local model (Ollama)**, model `qwen2.5:7b`, and
leave the base URL as `http://127.0.0.1:11434`. Press *Test*.

Local mode is the right choice when customer data must stay on the device.
Small models need a tighter prompt: shorten the system prompt, disable optional
tools, and keep the knowledge base to the essential facts. Expect slower replies
on CPU-only machines.

**Local-only mode** (`ai_local_only`) is a separate switch: when on, no request
is ever sent to a cloud provider, even if one is configured. Use it as a
guarantee, not a preference.

---

## Models

The suggested model list is only a starting point. Any model id the provider
accepts can be typed into the *Model* field — useful when a new model ships
before this list is updated. If a model name is wrong, the *Test* button says so
and the assistant falls back (see below) instead of producing garbage.

---

## What the assistant may do

Every capability is a tool with a declared schema, a required permission and
sometimes an approval step. The model can only choose from this list; it cannot
run SQL, read files or make network calls.

| Tool | Purpose | Notes |
| --- | --- | --- |
| `search_catalog` | Find products and services | Prices come from these rows only |
| `get_product` | Details for one item | |
| `check_availability` | Stock and lead time | |
| `add_order_item` | Add to the draft order | Does not create an order |
| `set_order_details` | Fulfilment, address, notes | |
| `get_order_summary` | The exact total to confirm with the customer | |
| `create_booking` | Appointment slot | Checks resources |
| `check_booking_availability` | Free slots | |
| `get_business_info` | Hours, address, policies | |
| `capture_lead` | Name, phone, interest | |
| `escalate_to_human` | Hand over | Tags the thread |
| `lookup_order` | Order status by number or phone | |
| `create_quotation` | Written quotation | Approval required |
| `request_payment` | Create a payment link | Only for a confirmed order |

Permissions are per business (`ai_operator_role`, default `owner`) and can be
narrowed per tool in **AI Configuration → Tools**. Anything marked as requiring
approval lands in the approval queue and waits for a human.

---

## The reply pipeline

For each incoming message:

1. Load the business config, the thread and the recent history.
2. Detect the language (Devanagari, romanised Nepali, English, mixed).
3. Build the system prompt: business facts, knowledge base excerpts, catalogue
   summary, tool list, hard rules, language instruction.
4. Call the provider with a timeout, retries and an optional fallback model.
5. Validate the reply: no prices that are absent from the catalogue, no
   invention of orders, no promises the business has not configured, length
   limits, no leaked system prompt.
6. Apply tool calls (with permission and approval gates).
7. Persist the message, the tool calls and an AI run record with token usage.
8. Escalate instead of answering when the customer asks for a human, raises a
   complaint, mentions a safety issue or a legal threat, or when confidence in
   the reply is low.

If a reply fails validation it is replaced with a safe holding message and the
thread is flagged — the customer never sees the rejected text.

---

## Cost control

- `ai_max_tokens` caps every reply.
- `ai_temperature` is intentionally low (0.4) by default.
- The AI usage report shows prompt/completion tokens and estimated cost per
  provider per day. Estimates are derived from the provider's reported usage and
  a price table; they are not a substitute for the provider's bill.
- Local mode costs nothing but CPU.

---

## If AI is unavailable

The system is designed to degrade, not to invent:

- No provider configured → replies are not generated; the thread is queued and
  the console shows "awaiting reply".
- Provider error/timeout → one retry, then the fallback model if configured,
  then the human handoff message.
- Rate limit from the provider → the message is queued and retried later.

What it will never do: quote a price it was not given, confirm an order the
customer did not confirm, or claim a payment succeeded.
