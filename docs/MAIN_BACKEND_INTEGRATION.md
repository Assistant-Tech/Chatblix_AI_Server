# Connecting Main Backend → AI Backend

> Implementation guide. Walks the main-backend team through environment
> setup → profile sync → inbound-message flow → error handling →
> observability → smoke test.
>
> Companion to [`AI_BACKEND_ARCHITECTURE.md`](./AI_BACKEND_ARCHITECTURE.md)
> (the contract reference). When they disagree, the architecture doc wins;
> update this guide.

---

## What this connects

```
                                                ┌───────────────────────┐
                                                │ TENANT DASHBOARD      │
                                                │ (yours)               │
                                                └──────────┬────────────┘
                                                           │  edit profile
                                                           ▼
┌─────────────────────────────────────┐         ┌───────────────────────┐
│  CUSTOMER (WhatsApp / IG / web)     │ msg in  │   MAIN BACKEND        │
│                                     │────────►│   (yours)             │
│                                     │ msg out │                       │
│                                     │◄────────│                       │
└─────────────────────────────────────┘         │  - channel webhooks   │
                                                │  - sign verify        │
                                                │  - conversation store │
                                                │  - operator queue     │
                                                │  - billing            │
                                                └──────────┬────────────┘
                                                  PUT /businesses/:id    POST /reply
                                                           │
                                                           ▼
                                                ┌───────────────────────┐
                                                │   AI BACKEND          │
                                                │   (this repo)         │
                                                │                       │
                                                │  - BusinessProfile    │
                                                │  - reply pipeline     │
                                                │  - TurnLog            │
                                                └───────────────────────┘
```

**Source of truth split:**

| Lives in main backend | Lives in AI backend |
|---|---|
| Tenants, users, plans, billing | `BusinessProfile` snapshot (replica of tenant data) |
| Channel webhooks + signature verify | Reply pipeline (triage + generator + validator + tone + safety) |
| Channel message sending | TurnLog (AI-side observability) |
| Long-term conversation history | Per-tenant compiled-prompt cache (Redis) |
| Operator queue + handoff state | — |
| Decision: "should the AI respond right now?" | — |

The AI backend's only job is **"given a message + history + business context, produce a reply or an escalation signal."** It has no state about your tenants beyond the `BusinessProfile` you push.

**Five public endpoints**, four behind a bearer token, one open:

```
PUT    /ai/v1/businesses/:id      ← push profile on tenant save
DELETE /ai/v1/businesses/:id      ← push delete on tenant offboard
POST   /ai/v1/reply               ← workhorse, one per inbound message
POST   /ai/v1/reply/stream        ← SSE-streamed, web widgets only
GET    /ai/v1/health              ← liveness, no auth
```

---

## Step 1 — Environment

Generate one shared bearer token; put the **same value** in both services' env:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Where | Example | Purpose |
|---|---|---|---|
| `AI_BACKEND_URL` | your env | `https://ai.internal.example.com` | Base URL for the four authenticated routes |
| `INTERNAL_API_TOKEN` | both envs | 64-char hex from above | Bearer token; constant-time compared on AI side |

Verify reachable + auth-clean:

```bash
curl -s "$AI_BACKEND_URL/ai/v1/health"
# → {"status":"ok","uptime_s":12,"version":"0.1.0"}

curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$AI_BACKEND_URL/ai/v1/reply" \
  -H "Authorization: Bearer wrong-token" -d '{}'
# → 401
```

---

## Step 2 — Push a business profile (`PUT /ai/v1/businesses/:id`)

### When to call

- **Tenant onboarding** — push the default profile immediately after the tenant record is created in your DB.
- **Every dashboard save** — synchronously, before returning 200 to the tenant. Synchronously so the next customer message sees fresh data.
- **Periodic re-sync** — a cron every 6–12h that re-PUTs all active profiles. Self-healing if main backend ever diverges from the AI cache (e.g., a Redis flush).

### Full body shape

Every field that exists today, populated. Optional fields are commented; everything else is required.

```jsonc
{
  "name": "Fresh & More",
  "description": "We sell organic skincare and groceries in Kathmandu.",

  // Optional. Drives a domain-adaptation block in the compiled prompt.
  // Known values today: "skincare" | "clothing" | "food" | "salon" |
  // "electronics" | "service". Free-form — unknown values fall back to a
  // generic "adapt to this domain" cue.
  "business_type": "skincare",

  // Primary language code. "en" | "romanized_ne" | "mixed". Pipeline runs
  // off TRIAGE.language.detected per-turn; this is the default.
  "language": "en",

  "tone": {
    "style": "friendly",              // "formal" | "friendly" | "casual"
    "persona_name": "Sita",
    "do":   ["Greet with Namaste", "End with a friendly close"],
    "dont": ["Discuss competitors", "Promise prices not in FAQ"]
  },

  "hours": {
    "timezone": "Asia/Kathmandu",     // IANA tz name; Luxon parses it
    "schedule": [
      { "day": "Monday",    "open": "09:00", "close": "20:00" },
      { "day": "Tuesday",   "open": "09:00", "close": "20:00" },
      { "day": "Wednesday", "open": "09:00", "close": "20:00" },
      { "day": "Thursday",  "open": "09:00", "close": "20:00" },
      { "day": "Friday",    "open": "09:00", "close": "20:00" },
      { "day": "Saturday",  "open": "10:00", "close": "18:00" }
    ],
    "holiday_message": "Namaste! We're closed right now. We'll reply at 9 AM tomorrow."
  },

  "faqs": [
    { "question": "Do you deliver to Bhaktapur?", "answer": "Yes, same-day before 2 PM." }
  ],

  "policies": {
    "return_policy":   "24-hour window for perishables.",
    "delivery_policy": "Same-day in Kathmandu valley; 2-3 days outside valley.",
    "payment_methods": ["eSewa", "Khalti", "COD"],
    "custom": []                      // optional free-form bullets
  },

  "escalation": {
    "triggers":         ["refund", "speak to human", "manager"],
    "handoff_message":  "Let me connect you to a teammate."
  },

  // Optional commercial surface. Prices are NPR by convention.
  "product_catalog": [
    {
      "name": "Neem Soap",
      "price": 499,
      "description": "Anti-acne bar",
      "tags": ["face", "bestseller"]
    }
  ],

  "locations": [
    { "name": "Newroad", "address": "Bishal Bazaar ko samu" }
  ],

  "current_offers": [
    { "title": "Bundle deal", "details": "Buy 2, get 10% off", "valid_until": "2026-12-31" }
  ],

  // NPR threshold above which the triage stage treats a deal as
  // high-value (gates escalation behavior).
  "high_value_threshold": 5000
}
```

### Field reference

| Field | Required | Notes |
|---|:---:|---|
| `name` | ✅ | 1–200 chars |
| `description` | ✅ | up to 2000 chars |
| `business_type` |  | optional but **strongly recommended** — controls per-domain LLM adaptation |
| `language` | ✅ | 2-16 chars; usually `en` or `romanized_ne` |
| `tone.style` | ✅ | enum: `formal` / `friendly` / `casual` |
| `tone.persona_name` | ✅ | display name the assistant uses for itself |
| `tone.do[]` / `tone.dont[]` | ✅ | up to 50 each |
| `hours.timezone` | ✅ | IANA tz string; invalid tz → outside-hours treats as closed |
| `hours.schedule[]` | ✅ | up to 14 entries; HH:MM open/close; cross-midnight ranges supported |
| `hours.holiday_message` | ✅ | used verbatim when outside hours |
| `faqs[]` | ✅ | up to 200 entries; empty array is fine |
| `policies.return_policy` / `delivery_policy` | ✅ | strings; quoted from the prompts |
| `policies.payment_methods[]` | ✅ | up to 20; unique |
| `policies.custom[]` |  | optional |
| `escalation.triggers[]` | ✅ | case-insensitive word-boundary match against inbound message |
| `escalation.handoff_message` | ✅ | sent verbatim on `status: escalate` |
| `product_catalog[]` |  | up to 500 entries; `name` required, `price`/`description`/`tags` optional |
| `locations[]` |  | up to 50 entries |
| `current_offers[]` |  | up to 20 entries; `valid_until` is ISO 8601 |
| `high_value_threshold` |  | NPR integer |

### Code skeleton

```ts
async function syncBusinessProfileToAi(tenant: Tenant): Promise<void> {
  const body = buildAiBackendProfile(tenant);          // map your DB row → the shape above

  const res = await fetch(`${AI_BACKEND_URL}/ai/v1/businesses/${tenant.id}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${INTERNAL_API_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    const { version, updated_at } = await res.json();
    await db.tenants.update(tenant.id, { ai_profile_version: version });
    return;
  }
  if (res.status === 422) {
    // Permanent — your body is malformed. Don't retry. Log + surface in dashboard.
    throw new ProfileValidationError(await res.json());
  }
  if (res.status === 401) {
    // Token mismatch. Page oncall.
    throw new AuthError('AI backend token rejected');
  }
  // 5xx → transient; retry with backoff.
  throw new TransientAiBackendError(res.status);
}
```

### Profile delete (`DELETE /ai/v1/businesses/:id`)

Call on tenant offboard. Always returns `204`. Subsequent `/reply` calls for that id return `404 business_not_found`. Idempotent — re-deleting a soft-deleted profile also returns 204.

---

## Step 3 — Handle an inbound customer message (`POST /ai/v1/reply`)

This is 99% of traffic. One call per inbound message after **you've decided** the AI should respond.

### The flow

```
inbound webhook
   │
   ▼
[1] verify signature (Meta / channel-specific)
[2] persist the inbound message in your conversations table
[3] resolve business_id from phone_number_id / channel_id
[4] guard: if conversation.ai_paused → STOP (operator owns it)
[5] load last 10 history turns from your DB
[6] derive request_id (e.g. sha256(message_id))
[7] POST /ai/v1/reply
[8] persist the assistant turn from the response
[9] dispatch based on response.status:
    - replied / outside_hours → send response.reply via channel
    - escalate                → send suggested_handoff_message,
                                 set ai_paused=true, push to operator queue
[10] on 503 → backoff once, retry, then fall back to operator
```

### Endpoint shape

```http
POST /ai/v1/reply
Authorization: Bearer {INTERNAL_API_TOKEN}
Content-Type: application/json

{
  "business_id":     "biz-123",
  "conversation_id": "conv-xyz",         // your conversation id, opaque to AI
  "contact_id":      "9779800000000",    // your contact id, opaque to AI
  "channel":         "whatsapp",         // "whatsapp" | "instagram" | "web" | ...
  "message": {
    "content":   "Pimple ko lagi kehi cha?",
    "timestamp": "2026-05-14T10:30:00Z"
  },
  "history": [                           // oldest first; cap 50 at DTO, AI trims to 10
    { "role": "user",      "content": "Hi",       "timestamp": "2026-05-14T10:29:00Z" },
    { "role": "assistant", "content": "Namaste!", "timestamp": "2026-05-14T10:29:05Z",
      "metadata": { "suggested_reply_language": "romanized_ne" }
    }
  ],
  "options": {
    "trace_id":   "trace-abc",           // your tracing id; echoed back, logged on AI side
    "request_id": "req-msg-7842"         // optional, see §6. Highly recommended.
  }
}
```

**Body limits:** 256 KiB total (`MAX_REQUEST_BYTES`). 413 if exceeded — almost always means history is too big; trim before retry.

### Three response shapes

#### `status: replied`

```json
{
  "status": "replied",
  "reply":  "Hajur, Neem Soap NPR 499 ko cha. Order garne ho hajur?",
  "metadata": {
    "triage":         { "intent": "concern", "sentiment": "neutral", "language": "romanized_ne" },
    "attempts":       1,
    "validator_pass": true,
    "model_used":     "anthropic/claude-sonnet-4.6",
    "tokens_in":      1240,
    "tokens_out":     87,
    "latency_ms":     1840,
    "trace_id":       "trace-abc"
  }
}
```

**Your action:** send `reply` verbatim through the channel. Persist as an assistant turn.

#### `status: escalate`

```json
{
  "status": "escalate",
  "reason": "keyword_match",          // | "triage_handoff" | "validator_exhausted"
  "suggested_handoff_message": "Let me connect you to a teammate.",
  "metadata": { "latency_ms": 22, "trace_id": "trace-abc", "attempts": 0 }
}
```

**Your action:** send `suggested_handoff_message` through the channel, set `conversation.ai_paused = true`, push the conversation into your operator queue. Do NOT call `/reply` again for this conversation until an operator releases it.

#### `status: outside_hours`

```json
{
  "status": "outside_hours",
  "reply":  "Namaste! We're closed right now. We'll reply at 9 AM tomorrow.",
  "metadata": { "latency_ms": 8, "trace_id": "trace-abc" }
}
```

**Your action:** send `reply` verbatim. No operator routing — the AI backend didn't call the LLM (this short-circuits on `BusinessProfile.hours`).

### Code skeleton

```ts
async function handleInboundCustomerMessage(msg: InboundMessage): Promise<void> {
  // [1-3] handled before this function

  // [4] guard
  const conv = await db.conversations.find(msg.conversation_id);
  if (conv.ai_paused) return;

  // [5] history
  const history = await db.messages
    .where({ conversation_id: msg.conversation_id })
    .orderBy('timestamp', 'asc')
    .limit(10)
    .select(['role', 'content', 'timestamp', 'metadata']);

  // [6] request_id for idempotency (so a webhook retry doesn't bill twice)
  const requestId = sha256(`${msg.channel_message_id}:${msg.timestamp}`);

  // [7] call
  let res: Response;
  try {
    res = await fetch(`${AI_BACKEND_URL}/ai/v1/reply`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INTERNAL_API_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        business_id:     conv.business_id,
        conversation_id: conv.id,
        contact_id:      msg.contact_id,
        channel:         msg.channel,
        message:         { content: msg.text, timestamp: msg.timestamp },
        history,
        options:         { trace_id: msg.trace_id, request_id: requestId },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return fallbackToOperator(conv, 'network_error', e);
  }

  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    if (!alreadyRetried(msg.id)) {
      await delay((body.retry_after_s ?? 2) * 1000);
      markRetried(msg.id);
      return handleInboundCustomerMessage(msg); // single retry
    }
    return fallbackToOperator(conv, 'llm_unavailable');
  }
  if (!res.ok) {
    // 4xx are permanent. Log + surface; never retry.
    return logAndAlert('ai_backend_4xx', { status: res.status, body: await res.text() });
  }

  // [8 + 9] persist + dispatch
  const reply = await res.json();
  await db.messages.insert({
    conversation_id: conv.id,
    role: 'assistant',
    content: reply.status === 'escalate' ? reply.suggested_handoff_message : reply.reply,
    metadata: reply.metadata,
    timestamp: new Date(),
  });

  switch (reply.status) {
    case 'replied':
    case 'outside_hours':
      await channel.send(msg.channel, msg.contact_id, reply.reply);
      break;

    case 'escalate':
      await channel.send(msg.channel, msg.contact_id, reply.suggested_handoff_message);
      await db.conversations.update(conv.id, { ai_paused: true });
      await operatorQueue.enqueue({
        conversation_id: conv.id,
        reason: reply.reason,
        trace_id: reply.metadata.trace_id,
      });
      break;
  }
}
```

---

## Step 4 — Error handling

### Status-code table

| Code | When | Action |
|---|---|---|
| `200` | Normal — one of the three statuses above | dispatch on `status` |
| `400 invalid_request` | Body is malformed JSON / wrong types | **permanent** — fix your client |
| `401 unauthorized` | Bearer token missing or wrong | rotate / inspect env |
| `404 business_not_found` | `business_id` unknown to AI backend | re-PUT the profile (your DB has a tenant the AI cache doesn't) |
| `413` | Body exceeds 256 KiB | trim history or split |
| `422` | DTO validation failed; `issues[]` names the offender | **permanent** — fix your body shape |
| `503 llm_unavailable` | OpenRouter timed out / rate-limited / 5xx'd | **retry once** after `retry_after_s`; then fall back to operator |

**Rule of thumb:** only `503` is retriable. Everything else is either your bug or a config issue.

### Pseudocode

```ts
async function handleReplyResponse(res: Response, ctx: Ctx): Promise<Outcome> {
  if (res.ok) return dispatchByStatus(await res.json(), ctx);

  switch (res.status) {
    case 400: case 404: case 413: case 422:
      log.error('permanent ai-backend error', { status: res.status });
      return Outcome.PermanentError;

    case 401:
      pager.notify('AI backend token rejected');
      return Outcome.AuthFailure;

    case 503:
      return Outcome.RetryThenFallback;

    default:
      log.error('unexpected ai-backend status', { status: res.status });
      return Outcome.PermanentError;
  }
}
```

---

## Step 5 — Streaming reply (`POST /ai/v1/reply/stream`)

**Only for live web-chat widgets.** WhatsApp, Instagram, SMS — those channels deliver one message at a time; partial tokens don't help and you'd just buffer the whole stream anyway.

Same input as `/reply`. Response is `text/event-stream`:

```
event: token
data: {"type":"token","text":"Hajur, ","attempt":0}

event: token
data: {"type":"token","text":"Neem Soap NPR 499 ko cha. ","attempt":0}

event: done
data: {"type":"done","response": { …full ReplyResponse as in §3 }}
```

**Close handling:** read `event: done`, then close the EventSource. Errors arrive as `event: error\ndata: {message: "..."}` followed by stream close.

**No request_id dedupe on stream.** Token replay isn't possible, so the same `request_id` runs fresh on retry. Don't rely on it for stream calls.

```ts
// front-of-house pattern: relay to a websocket / SSE the widget already has open
async function streamReplyToWidget(req: ReplyArgs, widget: WidgetConnection) {
  const res = await fetch(`${AI_BACKEND_URL}/ai/v1/reply/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${INTERNAL_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    for (const frame of consumeSSEFrames(buf)) {
      if (frame.event === 'token') widget.push(frame.data.text);
      if (frame.event === 'done')  { await persistTurn(frame.data.response); return; }
      if (frame.event === 'error') throw new Error(frame.data.message);
    }
    buf = remainder(buf);
  }
}
```

---

## Step 6 — Observability

### `trace_id` (always pass it)

Cheap to pass; pays for itself the moment something looks wrong. Forward your existing request-tracing id via `options.trace_id`. It flows through:

- Every structured log line on the AI backend that touches this turn.
- The `TurnLog` row written for this turn.
- The response `metadata.trace_id`, echoed back.

Lets you grep both sides' logs by the same id.

### `request_id` (recommended)

Pass `options.request_id` on every `/reply` call. Use a stable derived id like `sha256(channel_message_id)`.

- AI backend caches the response at `request:{id}` for 60 seconds with `NX`.
- A second call with the same id returns the cached response and **skips the pipeline entirely** — no second LLM cost, no second `TurnLog` row.
- The cached response is verbatim — including the original `trace_id`. If you retry, your new `trace_id` is dropped in favor of the first.

Makes your webhook retries cheap and idempotent.

### Internal stats (AI-team only)

These are AI-side operational endpoints — you can hit them too with the same bearer token, but they're not for tenants.

```
GET /ai/v1/internal/turns?from=&to=&business_id=&limit=
GET /ai/v1/internal/stats/p95-latency
GET /ai/v1/internal/stats/escalation-rate
GET /ai/v1/internal/stats/validator-pass-rate
```

Use them when debugging "why did this tenant's escalation rate jump?" — not for live dashboards.

---

## Step 7 — Smoke test (copy-paste)

Set the two env vars, then run top-to-bottom. Each block stands alone.

```bash
export TOKEN='<your INTERNAL_API_TOKEN>'
export URL='<your AI_BACKEND_URL>'

# ── 1. Liveness ─────────────────────────────────────────────
curl -s "$URL/ai/v1/health"
# expect: {"status":"ok",...}

# ── 2. Auth rejection ───────────────────────────────────────
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$URL/ai/v1/reply" \
  -H "Authorization: Bearer nope" -d '{}'
# expect: 401

# ── 3. Push a profile ───────────────────────────────────────
curl -s -X PUT "$URL/ai/v1/businesses/biz-smoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"Smoke Test Co","description":"smoke","business_type":"skincare","language":"en",
    "tone":{"style":"friendly","persona_name":"Sita","do":["Be brief"],"dont":["Discuss competitors"]},
    "hours":{"timezone":"Asia/Kathmandu","schedule":[
      {"day":"Monday","open":"00:00","close":"23:59"},
      {"day":"Tuesday","open":"00:00","close":"23:59"},
      {"day":"Wednesday","open":"00:00","close":"23:59"},
      {"day":"Thursday","open":"00:00","close":"23:59"},
      {"day":"Friday","open":"00:00","close":"23:59"},
      {"day":"Saturday","open":"00:00","close":"23:59"},
      {"day":"Sunday","open":"00:00","close":"23:59"}
    ],"holiday_message":"Closed."},
    "faqs":[],
    "policies":{"return_policy":"24h","delivery_policy":"Same-day","payment_methods":["eSewa","Khalti","COD"]},
    "escalation":{"triggers":["refund","manager"],"handoff_message":"Connecting you to a teammate."}
  }'
# expect: {"id":"biz-smoke","version":1,...}

# ── 4. Escalate path (no LLM needed) ────────────────────────
curl -s -X POST "$URL/ai/v1/reply" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "business_id":"biz-smoke","conversation_id":"c1","contact_id":"u1","channel":"web",
    "message":{"content":"I want a refund","timestamp":"2026-05-15T10:00:00Z"},
    "history":[],
    "options":{"trace_id":"smoke-trace","request_id":"smoke-req-1"}
  }'
# expect: {"status":"escalate","reason":"keyword_match",...}

# ── 5. Idempotency ──────────────────────────────────────────
curl -s -X POST "$URL/ai/v1/reply" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "business_id":"biz-smoke","conversation_id":"c1","contact_id":"u1","channel":"web",
    "message":{"content":"I want a refund","timestamp":"2026-05-15T10:00:00Z"},
    "history":[],
    "options":{"trace_id":"DIFFERENT-trace","request_id":"smoke-req-1"}
  }' | grep -o 'smoke-trace'
# expect: smoke-trace  (verbatim cache hit — your 2nd trace_id is dropped)

# ── 6. Cleanup ──────────────────────────────────────────────
curl -s -o /dev/null -w '%{http_code}\n' \
  -X DELETE "$URL/ai/v1/businesses/biz-smoke" \
  -H "Authorization: Bearer $TOKEN"
# expect: 204
```

If steps 1, 3, 4, 5, 6 all pass: you're integrated.

---

## Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| **Forgetting to pause the conversation on `escalate`** | Bot and human both reply to the same customer | After `escalate`, set `conversation.ai_paused = true`. Only operator can unset. |
| **Sending stale history** | Pipeline sees turns the customer can't see (or vice versa) | Reload history from your DB right before the `/reply` call; don't pass cached arrays. |
| **Treating 503 as permanent** | Drops messages on transient OpenRouter blips | 503 is the *only* retriable code. Retry once after `retry_after_s`. |
| **Treating 422 as transient** | Same broken payload retried forever | 422 means *your* body is bad. Fix client, alert, don't retry. |
| **Reusing channel message id as `conversation_id`** | Pipeline can't see prior turns; every reply is cold | `conversation_id` is the **conversation**, not the message. Many messages share one conversation_id. |
| **Streaming on non-web channels** | Buffers the whole stream, no UX gain, more code | Use `/reply` (not `/reply/stream`) for WhatsApp / IG / SMS. |
| **Trusting the AI cache after a profile edit** | New tenant edits aren't reflected | The AI backend invalidates both caches on `PUT`. *But* if your `PUT` fails / times out silently, fall back to a periodic re-sync (every 6–12h). |
| **No `request_id` on webhook retries** | Double-billed for the same inbound message | Pass a stable `request_id` (e.g. SHA-256 of channel message id). Free dedupe within 60s. |
| **Forgetting `business_type`** | Replies feel "off" for non-skincare tenants | Strongly recommended — controls per-domain LLM adaptation. |
| **Passing a long history** | 413 from the body-size guard | History caps at 50 entries at the DTO + 256 KiB total body. AI backend trims to 10 internally anyway — pass the last ~20 to be safe. |
| **Calling `/reply` from a worker that doesn't share env** | Random 401s on subset of traffic | All workers need the same `INTERNAL_API_TOKEN`. |

---

## What the AI backend does NOT do

If you're tempted to ask the AI backend for these — stop. They belong on your side:

- Receive channel webhooks (WhatsApp / IG / web).
- Verify Meta signatures.
- Send messages through channel APIs.
- Store long-term conversation history.
- Manage tenants, billing, plans.
- Run an operator dashboard / queue.
- Decide *when* to call the AI (rate limits, pause states, business-hours overrides beyond `hours`, etc.).

---

## Reference

- Contract source of truth: [`AI_BACKEND_ARCHITECTURE.md`](./AI_BACKEND_ARCHITECTURE.md) §5.
- Live Swagger docs: `{AI_BACKEND_URL}/ai/v1/docs`.
- Implementation progress / current capabilities: [`../tasks/PROGRESS.md`](../tasks/PROGRESS.md).
