# How Recent Conversations Reach the LLM

> **The question this doc answers:** "I get that the AI backend is stateless
> and doesn't store conversations — so how does the LLM actually see the
> last few turns when generating a reply?"
>
> Short answer: **the main backend includes the recent history in every
> `/ai/v1/reply` request body, and the AI backend hands it straight to the
> LLM as part of the `messages` array.** That's it — no retrieval, no
> database lookup on this side.

---

## 0. The big idea in one sentence

> **History is not stored, history is forwarded.** The main backend owns the
> conversation table; on every customer message it slices out the last N
> turns and ships them along with the new message in one HTTP call.

If that one sentence makes sense, the rest of this doc is just the
mechanics behind it.

---

## 1. The five-hop flow

```
┌─────────────────────┐
│ 1. CUSTOMER         │  "What size do you have?"
│    sends a message  │
│    on WhatsApp / IG │
└──────────┬──────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│ 2. MAIN BACKEND                                          │
│    a) receives the webhook, persists the new message     │
│       in its conversation table (source of truth)        │
│    b) SELECTs the last N turns for this conversation     │
│    c) packs them into the body of POST /ai/v1/reply      │
└────────────────────────────┬─────────────────────────────┘
                             │  HTTPS, history in body
                             ▼
┌──────────────────────────────────────────────────────────┐
│ 3. AI BACKEND — ReplyController                          │
│    receives ReplyRequest, validates the body shape       │
│    (history is just an array of {role, content} entries) │
│                                                          │
│    NEVER queries a conversation DB. There isn't one here.│
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ 4. AI BACKEND — PromptAssemblerService                   │
│    builds the LLM `messages` array:                      │
│      [ system: compiled KB,                              │
│        ...history (chronological),                       │
│        user: current message ]                           │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ 5. LLM — Anthropic via OpenRouter                        │
│    sees the entire context in one API call:              │
│    KB system prompt + all prior turns + new message      │
│    Generates the reply.                                  │
└──────────────────────────────────────────────────────────┘
```

Every arrow in this diagram is essential. Skip any one of them and the
LLM either fails to answer correctly (no history) or this service stops
being stateless (history pulled here, not received).

---

## 2. Step 2 — what the main backend sends

The `history` field carries all prior turns in the request body. Real shape
of `POST /ai/v1/reply`:

```jsonc
{
  "business_id":     "biz-123",
  "conversation_id": "conv-xyz-456",
  "contact_id":      "9779800000000",
  "channel":         "whatsapp",
  "message": {
    "content":   "What size do you have?",
    "timestamp": "2026-05-13T10:30:00Z"
  },
  "history": [
    {
      "role":      "user",
      "content":   "Namaste",
      "timestamp": "2026-05-13T10:25:00Z"
    },
    {
      "role":      "assistant",
      "content":   "Namaste! How can I help?",
      "timestamp": "2026-05-13T10:25:08Z"
    },
    {
      "role":      "user",
      "content":   "Do you have the orange scrub?",
      "timestamp": "2026-05-13T10:28:00Z"
    },
    {
      "role":      "assistant",
      "content":   "Yes, NPR 950. In stock.",
      "timestamp": "2026-05-13T10:28:11Z",
      "metadata": { "intent": "faq" }     // optional, see §6
    }
  ],
  "options": { "trace_id": "trace-abc-789" }
}
```

The main backend produced that `history` array by running essentially:

```sql
SELECT role, content, timestamp, metadata
FROM conversation_messages
WHERE conversation_id = 'conv-xyz-456'
ORDER BY timestamp DESC
LIMIT 10;
-- then reverse to chronological order before sending
```

Notes on the contract:

- `history` is **chronological** (oldest → newest). The new `message` is
  *not* included in `history` — it's a separate top-level field.
- Each entry is `{ role, content, timestamp, metadata? }`. The only roles
  the AI backend understands are `user`, `assistant`, and `operator`
  (treated as `assistant` for LLM purposes).
- The main backend chooses how many turns to send. AI backend trims
  defensively to `MAX_HISTORY_TURNS` (default 10) inside `ContextLoaderService`.
- Empty `history` is valid — first message in a new conversation.

---

## 3. Step 3 — what the AI backend does NOT do

This is the part most people get wrong because every other system caches
history server-side. **This one doesn't.**

```
❌ AI backend does NOT call: SELECT ... FROM conversation_messages
❌ AI backend does NOT have a conversation_messages table at all
❌ AI backend does NOT call back to the main backend to fetch history
❌ AI backend does NOT cache history in Redis
✅ AI backend reads history from the request body and uses it once
```

The `Conversation` and `ConversationMessage` Prisma models that were in
earlier draft docs are **gone** in the final design — `AI_BACKEND_ARCHITECTURE.md §7`
shows the actual two tables: `BusinessProfile` and `TurnLog`. Neither holds
conversation messages.

---

## 4. Step 4 — turning history into LLM `messages`

Inside `ReplyService.handle()`, the `PromptAssembler` produces the final
array that's sent to the LLM. This is the bridge between "main-backend
JSON" and "what the LLM API expects."

```ts
// src/pipeline/prompt-assembler.service.ts
@Injectable()
export class PromptAssemblerService {
  assemble(
    ctx: ContextPacket,
    triage: TriageResult,
    currentMessage: string,
    failureHint?: string,                       // present only on validator retry
  ): LLMMessage[] {
    return [
      // [a] System message — the compiled KB from the prompt cache
      {
        role: 'system',
        content: ctx.systemPrompt,
      },

      // [b] All prior turns from request body, chronological
      ...ctx.history.map(turn => ({
        role:    turn.role,                     // 'user' | 'assistant'
        content: turn.content,
      })),

      // [c] The new customer message, prefixed with triage hint
      //     and (on retry) the validator failure hint
      {
        role: 'user',
        content: this.formatUserTurn(currentMessage, triage, failureHint),
      },
    ];
  }

  private formatUserTurn(
    message: string,
    triage: TriageResult,
    failureHint?: string,
  ): string {
    const triagePrefix = `[Intent: ${triage.intent} | Sentiment: ${triage.sentiment}]`;
    if (failureHint) {
      return `${triagePrefix}\n\nPrevious attempt failed validation: ${failureHint}\n\nRetry. Customer message: ${message}`;
    }
    return `${triagePrefix}\n${message}`;
  }
}
```

That's the whole transformation. No magic. The LLM-API shape `{role, content}`
is the same shape `history` already arrived in, plus one new entry for the
current message.

---

## 5. Step 5 — the actual LLM API call

The `messages` array from §4 becomes the body of the HTTPS call to
OpenRouter (which forwards to Anthropic):

```http
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json
```
```jsonc
{
  "model": "anthropic/claude-sonnet-4.6",
  "messages": [
    {
      "role": "system",
      "content": "You are Sita, the AI assistant for Fresh & More.\n\nTONE & STYLE\nStyle: friendly\nAlways: Greet with Namaste\n\nBUSINESS HOURS (Asia/Kathmandu)\nMonday: 09:00-20:00\n\nPRODUCT CATALOG\n- Orange Face Scrub (SKU FM-SCRUB-ORANGE) - NPR 950, 100g jar, in stock\n- Beet Root Face Mask (SKU FM-MASK-BEETROOT) - NPR 1100, 80g jar, in stock\n...\n\nFREQUENTLY ASKED QUESTIONS\nQ: Do you deliver to Bhaktapur?\nA: Yes, same-day before 2 PM.\n\nRULES\n- Only answer from the information above..."
    },
    { "role": "user",      "content": "Namaste" },
    { "role": "assistant", "content": "Namaste! How can I help?" },
    { "role": "user",      "content": "Do you have the orange scrub?" },
    { "role": "assistant", "content": "Yes, NPR 950. In stock." },
    { "role": "user",      "content": "[Intent: sales_inquiry | Sentiment: neutral]\nWhat size do you have?" }
  ],
  "max_tokens": 1024,
  "temperature": 0.7
}
```

What the LLM does with this:

1. Reads the system prompt → learns the persona, tone, hours, catalog, FAQs.
2. Reads the 4 prior turns → builds a mental model of the conversation.
3. Reads the last user turn → resolves "what size" against the recent
   context ("the orange scrub") → looks up the catalog entry in the
   system prompt → finds "100g jar".
4. Generates the reply: `"The Orange Face Scrub comes in a 100g BPA-free jar."`

**That is the entire mechanism.** No retrieval, no embeddings, no RAG.
History is just `messages` array entries; KB is the `system` content; the
LLM does the rest.

---

## 6. The optional `metadata` on history entries

Each `history` entry can carry an optional `metadata` object that the main
backend captured from previous turns. AI backend mostly ignores it during
generation but can use it for two things:

- **Sentiment trend for escalation rules.** If the last 3 user turns had
  `metadata.sentiment === 'negative'`, the deterministic escalation rule
  fires (`EscalationRulesService.check`).
- **Stalled-count tracking.** If `metadata.agent_asked_question === true`
  on the last 3 assistant turns and none got answered, surface this in
  the triage hint.

The LLM itself does NOT see `metadata` — `PromptAssembler` only forwards
`role` and `content`. Metadata is for the deterministic rule layer.

---

## 7. What happens with prompt caching

Anthropic prompt caching works on **prefixes**. The `system` block (the KB)
is the same string across every request for a given business until the
profile is PUT, so it's an ideal cache target.

The `history` array, however, **changes on every call** (one more turn
every time). So the cache hit looks like:

```
┌─────────────────────────────────┐
│ system message (compiled KB)    │  ← CACHED — same across all calls
│   ~5 400 tokens                 │     for this business
├─────────────────────────────────┤
│ history turns                   │  ← NOT cached — grows each call
│   ~1 200 tokens                 │
├─────────────────────────────────┤
│ current message + triage hint   │  ← NOT cached — unique each call
│   ~80 tokens                    │
└─────────────────────────────────┘
```

Only the system block is marked with `cache_control: { type: "ephemeral" }`.
Roughly 80 % of input tokens land in the cached portion → ~70 % cost
reduction at steady state. Details in `COST_AND_BILLING.md §6`.

---

## 8. Edge cases

### 8.1 First message in a brand-new conversation

Main backend sends `"history": []`. The `messages` array becomes just:

```jsonc
[
  { "role": "system", "content": "<KB>" },
  { "role": "user",   "content": "[Intent: greeting]\nHi" }
]
```

LLM generates a clean opening response.

### 8.2 Very long conversations (50+ turns)

Main backend should cap to ~10 turns before sending — the LLM rarely needs
deeper context, and tokens stack up fast. If main backend doesn't trim, the
AI backend does (see `MAX_HISTORY_TURNS` env var, default 10).

For workloads where deeper history matters (long sales conversations),
consider sending a **summary** of pre-history-window turns as a
synthetic first `assistant` message:

```jsonc
"history": [
  { "role": "assistant", "content": "[Conversation summary]: Customer expressed interest in face scrubs, mentioned sensitive skin, lives in Bhaktapur, prefers COD." },
  { "role": "user",      "content": "..." },
  { "role": "assistant", "content": "..." },
  ...
]
```

This is a future optimization — not needed for v1.

### 8.3 Operator-handled turns mixed in

When an operator took over part of the conversation, the messages they
sent are stored in the main backend with `role: "operator"`. When
forwarding to the AI backend, the main backend should map those to
`role: "assistant"` — the LLM doesn't have a separate operator role and
should treat operator replies as authoritative prior agent output.

```jsonc
// main backend's conversation table:
{ "role": "operator", "content": "Hi, this is Ram from the team." }

// what it sends in history:
{ "role": "assistant", "content": "Hi, this is Ram from the team." }
```

### 8.4 Re-prompting after a validator retry

When the validator rejects the first draft and the orchestrator retries,
the **`history` is the same** — what changes is the last `user` entry,
which gets the failure hint appended (`§4` code). This is intentional: we
don't add the failed draft to history (the customer never saw it).

---

## 9. Why "history in body" beats "history in DB"

| Property | Stateless (this design) | Stateful (DB-backed history in AI service) |
|---|---|---|
| Sync bugs between main + AI backends | ✅ None — single source of truth | ❌ Two copies drift |
| Horizontal scaling | ✅ Any pod serves any request | ❌ Sticky sessions or distributed cache needed |
| Disaster recovery | ✅ Lose the AI DB → re-sync profiles, zero conversation loss | ❌ Lose AI DB → lose conversation context for in-flight chats |
| Replay/test a turn | ✅ Save the request JSON, replay anytime | ❌ Must reproduce DB state at that exact moment |
| Cost of one extra GET on hot path | ✅ Zero — already in body | ❌ ~5–20 ms per call against the DB |
| Main backend doing more work | ❌ One extra `SELECT ... LIMIT 10` per call | ✅ AI backend handles it |

The one "downside" — main backend does a tiny `SELECT` — is paid by code
they're going to write anyway because main backend already needs the
history to render its own dashboard.

---

## 10. Common confusion clarified

- **Q:** "If the AI is stateless, how does it remember a customer's name?"
  **A:** It doesn't *remember* — it *reads*. The customer's name appears
  in `history[k].content` somewhere, and the LLM picks it up in context.
  Same way you'd remember a name from reading a thread.

- **Q:** "Doesn't every request carry the entire history? Isn't that wasteful?"
  **A:** Capped at ~10 turns × ~120 tokens = ~1.2 KB. That's less than a
  single HTTP request header bundle. The cost lives in LLM input tokens
  (priced separately), not in the network call.

- **Q:** "What if the main backend forgets to send history?"
  **A:** AI backend treats it as an empty conversation. The LLM will
  greet the customer fresh. Worst case: it asks something already
  answered. Validator catches grossly out-of-context replies via
  grounding check.

- **Q:** "What if the main backend lies and sends fake history?"
  **A:** AI backend trusts main backend (shared `INTERNAL_API_TOKEN`).
  Both services are inside your infra. Authenticated and authorized.

- **Q:** "Could AI backend cache history per-conversation to skip the
  network bytes?"
  **A:** Technically yes, but it would re-introduce all the sync-bug
  problems the stateless design eliminates. Not worth it.

---

## 11. Where this fits in the docs

- **`AI_BACKEND_ARCHITECTURE.md §5.2`** — defines the `ReplyRequest`
  schema where the `history` field lives.
- **`AI_BACKEND_ARCHITECTURE.md §6`** — end-to-end walkthrough; this doc
  zooms in on the history portion of that walkthrough.
- **`KB_MANAGEMENT.md §5`** — code-level view of `ReplyService.handle()`,
  where history is consumed alongside the compiled KB.
- **`COST_AND_BILLING.md §3` and §6** — how the cached KB vs. fresh
  history split affects per-turn cost.

---

## 12. The single thing to remember

If someone asks you "where does the AI backend get conversation history,"
the right answer is one sentence:

> **From the request body. The main backend ships it in every `/ai/v1/reply`
> call. There's no history table in this service.**

That's the whole design.
