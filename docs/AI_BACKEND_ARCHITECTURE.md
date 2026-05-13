# AI Backend — Service Architecture

> **This document supersedes `MULTI_TENANT_PLAN.md` and `IMPLEMENTATION_GUIDE.md`.**
> Those docs treated this NestJS service as the entire platform. It isn't —
> it's a focused AI microservice sitting behind a main backend that already
> handles channels, tenants, conversations, and operators.

---

## 0. The single most important shift

Read this before anything else.

**This NestJS service does exactly one thing:** given an incoming customer
message + the relevant business context, run the LLM pipeline and return
either a reply or an escalation signal.

It is **not** the system of record for:
- channel integrations (WhatsApp/Instagram/etc.) → main backend
- tenants and their billing/auth → main backend
- conversations (long-term storage of messages) → main backend
- operators and the human handoff queue → main backend
- the customer-facing dashboard → main backend

It **is** the system of record for:
- the compiled system prompt for each business (cached, derived from a profile pushed by main backend)
- the per-turn trace log (what the LLM did, why, how long, how many tokens) — for AI quality analysis
- nothing else

That's the whole mental model. Everything below is consequences of this.

---

## 1. System context — who calls whom

```
                  ┌──────────────────┐
   end users  ──► │  Main Backend    │ ──► channel APIs (Meta etc.)
   (WhatsApp,     │  ───────────────  │
    IG, web)      │  • channel inbox │
                  │  • tenant DB     │
                  │  • conversation  │
                  │    history       │
                  │  • operator      │
                  │    dashboard     │
                  │  • billing       │
                  └────────┬─────────┘
                           │  HTTPS, internal token
                           │  POST /ai/v1/reply
                           │  PUT  /ai/v1/businesses/{id}
                           ▼
                  ┌──────────────────┐
                  │  AI Backend      │
                  │  (this service)  │
                  │  ───────────────  │
                  │  • prompt compiler│
                  │  • triage         │       ┌──────────────┐
                  │  • generator      │ ────► │  OpenRouter  │
                  │  • validator      │       │  (LLM API)   │
                  │  • turn log       │       └──────────────┘
                  └────────┬─────────┘
                           │
                  ┌────────┴─────────┐
                  ▼                  ▼
            ┌──────────┐       ┌─────────┐
            │ Postgres │       │  Redis  │
            │ (profiles│       │ (prompt │
            │  + logs) │       │  cache) │
            └──────────┘       └─────────┘
```

**Direction of every arrow matters:**

- Main backend → AI backend: **always**. AI backend never initiates a call to main backend.
- AI backend → Redis/Postgres/OpenRouter: as needed during a request.
- AI backend → end-user: **never directly**. Replies go back to the main backend, which sends them through the channel.

This unidirectional flow is the single most important property of the design.
It means:
- AI backend can be redeployed/restarted without coordinating with anything else.
- AI backend has no webhooks to authenticate from Meta — main backend handles all of that.
- AI backend has no concept of "channel credentials," "operator JWTs," or "Meta signatures."

---

## 2. Responsibility split (the contract)

| Concern | Main Backend | AI Backend |
|---------|:------------:|:----------:|
| Receive channel webhooks (WhatsApp/IG/web) | ✅ | — |
| Verify Meta signatures | ✅ | — |
| Send replies through channel APIs | ✅ | — |
| Store full conversation history | ✅ | — |
| Manage tenants (signup, billing, plans) | ✅ | — |
| Operator dashboard & queue | ✅ | — |
| Decide *when* to call the AI | ✅ | — |
| Persist business profile (source of truth) | ✅ | — |
| Compile profile into a system prompt | — | ✅ |
| Triage / Generator / Validator pipeline | — | ✅ |
| Per-turn trace log for AI debugging | — | ✅ |
| Decide *what to say* | — | ✅ |
| Detect when to escalate | — | ✅ |

**Rule of thumb:** if a feature is visible to a tenant or end-user, it lives
in main backend. If it's about how the AI thinks, it lives here.

---

## 3. Why this design (the reasoning a senior would give)

### 3.1 Stateless w.r.t. conversations

Main backend has conversation history. AI backend does **not** keep a shadow
copy. Every request from main backend includes the last N turns the AI needs.

Why:
- One source of truth eliminates sync bugs. (If both sides stored messages,
  they'd drift, and the AI would respond based on stale state.)
- AI backend can be scaled horizontally without sticky sessions — any pod
  can handle any request because none of them hold conversation state.
- Disaster recovery is trivial: lose the AI backend's database entirely
  and the worst that happens is profile re-sync from main + a fresh turn log.

The trade-off: every request carries a few KB of history payload. That's
~10× cheaper than the network/DB cost of fetching it from main backend on
demand.

### 3.2 Profiles pushed, not pulled

Main backend `PUT`s the business profile to AI backend whenever it changes.
AI backend stores it in its own Postgres and Redis. AI backend never fetches
from main backend.

Why:
- **Tight hot path.** Reply latency budget is ~3 seconds. A synchronous
  HTTP call to main backend on every request would add 50–200 ms of
  unnecessary latency.
- **Cache control is local.** AI backend knows exactly when to invalidate
  its compiled-prompt cache because it received the update.
- **Decouples deploys.** Main backend can be down for maintenance and AI
  backend keeps replying with the last known profile.

### 3.3 Escalation is a return value, not a side effect

When the AI decides to escalate, it returns `{ status: "escalate", reason, ... }`
in the HTTP response. It does **not** call any operator queue. Main backend
sees the response and routes to its own operator system.

Why:
- AI backend doesn't know what an operator is or how the main backend
  routes humans.
- Keeps AI backend testable in isolation — assertions on return values
  rather than on external side effects.

### 3.4 No streaming for channel-driven traffic

`POST /ai/v1/reply` is **non-streaming JSON**. Streaming exists only for
web chat widgets where partial tokens improve UX, exposed as a separate
`POST /ai/v1/reply/stream` endpoint.

Why:
- WhatsApp/Instagram/SMS don't support partial messages. The main backend
  has to wait for the full reply before sending anyway. Streaming would
  just add complexity without UX benefit.
- Internal service-to-service traffic is easier to log, retry, and rate-limit
  when it's plain JSON.

---

## 4. The contract — endpoints the main backend uses

The full public API of this service. **Five endpoints total.**

### 4.1 Health
```
GET  /ai/v1/health
```
Returns `{ status: "ok", uptime_s, version }`. No auth.
Used by load balancers and main backend's circuit breaker.

### 4.2 Push a business profile
```
PUT  /ai/v1/businesses/{business_id}
Authorization: Bearer <INTERNAL_API_TOKEN>
Content-Type: application/json
Body: <BusinessProfile JSON>
```
Upserts the profile, invalidates the Redis prompt cache for that business.
Returns `{ id, version, updated_at }`.

Idempotent — same body produces same result.

### 4.3 Delete a business profile
```
DELETE /ai/v1/businesses/{business_id}
Authorization: Bearer <INTERNAL_API_TOKEN>
```
Soft-deletes. AI backend rejects subsequent `/reply` calls for this
business with `404`. Returns `204`.

### 4.4 Generate a reply
```
POST /ai/v1/reply
Authorization: Bearer <INTERNAL_API_TOKEN>
Content-Type: application/json
Body: ReplyRequest
```
Returns `ReplyResponse`. This is the workhorse endpoint — 99% of traffic.

### 4.5 Generate a reply (streaming)
```
POST /ai/v1/reply/stream
Authorization: Bearer <INTERNAL_API_TOKEN>
```
Same input shape, returns `text/event-stream`. Used by web chat widgets.

**That's it.** No tenant CRUD, no operator endpoints, no channel webhooks,
no auth flows. Five endpoints.

---

## 5. Request/response shapes — copy-paste ready

### 5.1 `BusinessProfile` (sent to `PUT /ai/v1/businesses/{id}`)

```jsonc
{
  "name": "Fresh & More",
  "description": "We sell organic groceries in Kathmandu.",
  "language": "en",                          // primary language code
  "tone": {
    "style": "friendly",                     // "formal" | "friendly" | "casual"
    "persona_name": "Sita",
    "do":   ["Greet with Namaste", "End with a friendly close"],
    "dont": ["Discuss competitors", "Promise prices not in FAQ"]
  },
  "hours": {
    "timezone": "Asia/Kathmandu",
    "schedule": [
      { "day": "Monday",  "open": "09:00", "close": "20:00" },
      { "day": "Tuesday", "open": "09:00", "close": "20:00" }
    ],
    "holiday_message": "Namaste! We're closed right now. We'll reply at 9 AM tomorrow."
  },
  "faqs": [
    { "question": "Do you deliver to Bhaktapur?", "answer": "Yes, same-day before 2 PM." }
  ],
  "policies": {
    "return_policy":   "24-hour window for perishables.",
    "delivery_info":   "Same-day in Kathmandu valley.",
    "payment_methods": ["eSewa", "Khalti", "COD"],
    "custom": []
  },
  "escalation": {
    "triggers": ["refund", "speak to human", "manager"],
    "handoff_message": "Let me connect you to a teammate."
  }
}
```

### 5.2 `ReplyRequest` (sent to `POST /ai/v1/reply`)

```jsonc
{
  "business_id": "biz-123",                  // matches a previously pushed profile
  "conversation_id": "conv-xyz-456",         // opaque, used in logs only
  "contact_id": "9779800000000",             // also opaque, for logs
  "channel": "whatsapp",                     // "whatsapp" | "instagram" | "web" | ...
  "message": {
    "content": "Do you deliver to Bhaktapur?",
    "timestamp": "2026-05-13T10:30:00Z"
  },
  "history": [                               // last N turns, oldest first
    {
      "role": "user",
      "content": "Hi",
      "timestamp": "2026-05-13T10:29:00Z"
    },
    {
      "role": "assistant",
      "content": "Namaste! How can I help?",
      "timestamp": "2026-05-13T10:29:05Z",
      "metadata": { "intent": "greeting" }   // optional — assistant turn metadata
    }
  ],
  "options": {                               // optional knobs
    "force_model": null,                     // override generator model
    "skip_validator": false,                 // for low-risk channels
    "trace_id": "trace-abc-789"              // propagate from main backend logs
  }
}
```

History length is the main backend's choice. AI backend trims internally to
its own token budget (default last 10 turns).

### 5.3 `ReplyResponse` — happy path

```jsonc
{
  "status": "replied",
  "reply": "Hajur, we deliver same-day to Bhaktapur for orders before 2 PM.",
  "metadata": {
    "triage":  { "intent": "faq", "sentiment": "neutral", "language": "en" },
    "attempts": 1,
    "validator_pass": true,
    "model_used": "anthropic/claude-sonnet-4.6",
    "tokens_in": 1240,
    "tokens_out": 87,
    "latency_ms": 1840,
    "trace_id": "trace-abc-789"
  }
}
```

### 5.4 `ReplyResponse` — escalation

```jsonc
{
  "status": "escalate",
  "reason": "validator_exhausted",           // also: "triage_handoff", "keyword_match"
  "suggested_handoff_message": "Let me connect you to a teammate.",
  "metadata": {
    "triage": { "intent": "complaint", "sentiment": "angry" },
    "attempts": 2,
    "validator_pass": false,
    "last_violations": [ "grounding_failed", "tone_banned_phrase" ],
    "latency_ms": 4230,
    "trace_id": "trace-abc-789"
  }
}
```

### 5.5 `ReplyResponse` — outside hours

```jsonc
{
  "status": "outside_hours",
  "reply": "Namaste! We're closed right now. We'll reply at 9 AM tomorrow.",
  "metadata": {
    "latency_ms": 8,                         // no LLM call was made
    "trace_id": "trace-abc-789"
  }
}
```

### 5.6 Error responses

```jsonc
// 401 — missing/invalid INTERNAL_API_TOKEN
{ "error": "unauthorized" }

// 404 — business_id not known (profile never pushed, or deleted)
{ "error": "business_not_found", "business_id": "biz-123" }

// 422 — malformed request
{ "error": "invalid_request", "issues": ["message.content is required"] }

// 503 — upstream LLM failure after retries
{ "error": "llm_unavailable", "retry_after_s": 30 }
```

The main backend should treat `503` as retriable and any 4xx as permanent.

---

## 6. End-to-end example — one customer message, traced

**Setup that already happened on the main backend:**

- Tenant "Fresh & More" exists in main backend's DB with `business_id=biz-123`.
- Main backend has pushed the profile to AI backend:
  `PUT /ai/v1/businesses/biz-123 { ... }`.
- AI backend stored it in Postgres, compiled it on first read, cached the
  compiled prompt in Redis at key `prompt:biz-123`.

**Now Ram messages Fresh & More on WhatsApp:**

```
[1] Customer → WhatsApp → Meta webhook → Main Backend
    Main backend:
      • verifies Meta signature
      • persists message in its conversations table
      • looks up business by phone_number_id → biz-123
      • loads last 10 turns from its history
      • is the conversation paused for operator? no → call AI

[2] Main Backend → AI Backend
    POST /ai/v1/reply
    Authorization: Bearer <INTERNAL_API_TOKEN>
    {
      "business_id": "biz-123",
      "conversation_id": "conv-xyz",
      "contact_id": "9779800000000",
      "channel": "whatsapp",
      "message": { "content": "Do you deliver to Bhaktapur?", "timestamp": "..." },
      "history": [ ...last 10 turns... ],
      "options": { "trace_id": "trace-abc" }
    }

[3] Inside AI Backend
    a) Auth guard: validate INTERNAL_API_TOKEN.
    b) ContextLoader:
         • Redis GET prompt:biz-123  →  cached compiled prompt
         • Postgres SELECT BusinessProfile WHERE id='biz-123'  (for tone.dont,
           hours, escalation.triggers — also cacheable)
         • history comes from request body — no DB call
    c) HoursService.isWithinHours(profile)  →  true. Continue.
    d) TriageService → LLM call (Haiku, ~400 ms):
         { intent: "faq", sentiment: "neutral", handoff_flag: false }
    e) EscalationRules.check(message, history, profile)
         No keyword match. Continue.
    f) Orchestrator.runWithValidation():
         attempt 1:
           • PromptAssembler builds messages array
           • LLMClient.complete() (Sonnet, ~1300 ms) → draft
           • ResponseCleaner.clean(draft) → strip prefixes
           • Validator.checkGrounding() (Haiku, ~350 ms) → pass
           • ToneChecker.check() → pass (no banned phrases)
           • SafetyFilter.check() → pass (no PII)
         → return draft
    g) Write TurnLog row (business_id, conversation_id, latency, tokens, ...)
    h) Return ReplyResponse to main backend

[4] AI Backend → Main Backend (HTTP 200)
    {
      "status": "replied",
      "reply": "Hajur, we deliver same-day to Bhaktapur before 2 PM.",
      "metadata": { ... }
    }

[5] Main Backend
      • appends assistant message to its conversations table
      • calls WhatsApp Cloud API to send the reply
      • logs the turn in its own analytics

[6] Customer receives reply on WhatsApp
```

**Total latency: ~2.1 s.** Of that, ~2.05 s is AI backend; the rest is
main-backend coordination + WhatsApp API.

**If [3f] had failed twice** (validator rejected both attempts), step 4
would have been:

```
{
  "status": "escalate",
  "reason": "validator_exhausted",
  "suggested_handoff_message": "Let me connect you to a teammate.",
  "metadata": { ... }
}
```

Main backend would then:
- send the `suggested_handoff_message` to the customer through WhatsApp
- pause the conversation (`ai_paused = true` in its DB)
- push a queue item into its own operator system

The AI backend never knew an operator existed.

---

## 7. Data model — only what the AI backend owns

Cut from the previous design. Final shape:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

// The cached snapshot of a tenant's profile, pushed by main backend.
model BusinessProfile {
  id              String   @id            // matches main backend's business id
  name            String
  description     String
  language        String   @default("en")
  tone            Json
  hours           Json
  faqs            Json
  policies        Json
  escalation      Json
  version         Int      @default(1)    // bumped on every PUT
  active          Boolean  @default(true) // false after DELETE
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt
}

// One row per pipeline run. AI-team observability only.
model TurnLog {
  id                       String   @id @default(uuid())
  business_id              String
  conversation_id          String
  contact_id               String
  channel                  String
  ts                       DateTime @default(now())
  status                   String                       // "replied" | "escalate" | "outside_hours"
  triage                   Json
  attempts                 Json
  validator_pass           Boolean  @default(false)
  retry_count              Int      @default(0)
  high_severity_violations Int      @default(0)
  intent_path              String?
  language                 String?
  shipped                  String                        // the final reply or handoff message
  tokens_in                Int?
  tokens_out               Int?
  duration_ms              Int
  trace_id                 String?
  model_triage             String?
  model_generator          String?
  model_validator          String?

  @@index([business_id, ts])
  @@index([trace_id])
  @@index([business_id, conversation_id, ts])
}
```

**Two tables. That's the entire schema.**

Notice what is **gone** compared to today:
- `Lead` — main backend owns customer state
- `Message` — main backend owns conversation history

The conversation history needed by triage/generator/validator comes from the
**request body** (`history` array in `ReplyRequest`), not the database.

---

## 8. Internal architecture (services inside the AI backend)

NestJS module layout. Same shape as today, but smaller and cleaner.

```
src/
├── main.ts
├── app.module.ts
│
├── config/                          (keep)
│   ├── env.validation.ts            (add INTERNAL_API_TOKEN, REDIS_URL)
│   ├── app-config.service.ts
│   └── config.module.ts
│
├── prisma/                          (keep)
│   ├── prisma.service.ts
│   └── prisma.module.ts
│
├── cache/                           NEW
│   ├── redis.client.ts              singleton ioredis
│   ├── prompt-cache.service.ts      get/set/invalidate compiled prompts
│   └── cache.module.ts
│
├── business/                        NEW
│   ├── business-profile.service.ts  upsert/get/delete
│   ├── system-prompt-compiler.service.ts   profile → string
│   ├── businesses.controller.ts     PUT/DELETE /ai/v1/businesses/{id}
│   └── business.module.ts
│
├── pipeline/                        REFACTOR existing
│   ├── triage.service.ts            accept ContextPacket
│   ├── generator.service.ts         accept ContextPacket
│   ├── validator.service.ts         accept ContextPacket
│   ├── orchestrator.service.ts      add tone+safety checks
│   ├── prompt-assembler.service.ts  NEW
│   ├── response-cleaner.service.ts  NEW
│   ├── tone-checker.service.ts      NEW (rule-based)
│   ├── safety-filter.service.ts     NEW (regex/PII)
│   ├── hours.service.ts             NEW (timezone)
│   ├── escalation-rules.service.ts  NEW (keyword + sentiment)
│   ├── llm-client.service.ts        NEW wrapper around openrouter.client
│   ├── openrouter.client.ts         (keep)
│   ├── metrics.service.ts           (keep, simplify)
│   └── pipeline.module.ts
│
├── reply/                           NEW (the public reply endpoint)
│   ├── reply.controller.ts          POST /ai/v1/reply, POST /ai/v1/reply/stream
│   ├── reply.service.ts             orchestrates: context-load → triage → ...
│   ├── context-loader.service.ts    builds ContextPacket from profile + request history
│   └── reply.module.ts
│
├── auth/                            NEW
│   ├── internal-token.guard.ts      one bearer-token guard for all routes
│   └── auth.module.ts
│
├── common/                          (keep types + utils)
│   ├── types/
│   │   ├── reply.dto.ts             ReplyRequest, ReplyResponse, BusinessProfile shapes
│   │   └── pipeline.types.ts
│   └── utils/
│
└── health/                          (keep)
    └── health.controller.ts         GET /ai/v1/health
```

**What gets deleted entirely:**

- `src/chat/` — replaced by `src/reply/`. The old `POST /api/chat` endpoint is gone.
- `src/history/` — main backend owns this.
- `src/pipeline/kb/`, `src/pipeline/corpus.service.ts`, `src/pipeline/prompts/` —
  the KB system is replaced by `BusinessProfile` + `SystemPromptCompiler`.

**What gets renamed:**

- `chat-stream.service.ts` logic → folded into `reply.service.ts`
- `chat.controller.ts` → `reply.controller.ts`

---

## 9. Auth between main backend and AI backend

**Single bearer token.** Shared between main backend and AI backend, set via
`INTERNAL_API_TOKEN` env var on both sides.

```
Authorization: Bearer <INTERNAL_API_TOKEN>
```

Why this is enough:
- Both services run in your infra. Traffic doesn't leave your VPC.
- A leaked token rotates with a single env-var change + restart.
- mTLS or signed requests would be defense-in-depth, not strictly necessary
  for v1.

**Apply globally with one guard:**

```ts
// src/auth/internal-token.guard.ts
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private config: AppConfigService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (token !== this.config.internalToken()) {
      throw new UnauthorizedException('invalid internal token');
    }
    return true;
  }
}

// Apply globally in app.module.ts via APP_GUARD, with @Public() decorator
// on GET /ai/v1/health (the only unauthenticated route).
```

**Future hardening (when needed, not now):**
- Add HMAC-signed requests with timestamp + nonce to defeat replay.
- Add per-route allowlists (e.g. main backend can call `/reply` but not `/businesses/:id/delete`).

---

## 10. Caching strategy

Three layers, each with a clear job.

### 10.1 Compiled-prompt cache (Redis)

- **Key:** `prompt:{business_id}`
- **Value:** the rendered system prompt string
- **TTL:** none — invalidated explicitly on profile update/delete
- **Why Redis, not in-process:** AI backend will run multiple pods; in-process
  cache would diverge.

### 10.2 Business profile cache (Redis, optional)

- **Key:** `profile:{business_id}`
- **Value:** the BusinessProfile JSON
- **TTL:** 5 minutes (safety net in case invalidation is missed)
- **Why also cache the profile and not just the compiled prompt:** services
  like `EscalationRulesService` and `HoursService` need the raw profile,
  not the compiled string.

### 10.3 LLM-response cache (Redis, future)

- **Key:** SHA-256 of `(system_prompt, last 5 turns, message)`
- **Value:** the validated reply
- **TTL:** 1 hour
- **When:** if you ever see the same exact question repeated within a tenant
  (FAQ-heavy workloads), this saves significant LLM cost. Skip for v1.

### Invalidation

```ts
// inside BusinessProfileService.upsert / delete:
await this.promptCache.invalidate(business_id);  // Redis DEL prompt:{id}
await this.profileCache.invalidate(business_id); // Redis DEL profile:{id}
```

Both invalidations happen synchronously before responding `200` to the
main backend's `PUT`. That way the very next `/reply` call sees fresh data.

---

## 11. Concurrency, idempotency, retries

### `PUT /ai/v1/businesses/{id}` is idempotent

Same body → same outcome. Main backend can retry safely. Internally:
```sql
INSERT INTO BusinessProfile (...) VALUES (...)
ON CONFLICT (id) DO UPDATE SET ..., version = version + 1, updated_at = NOW();
```

### `POST /ai/v1/reply` is **not** idempotent by default

Each call runs the pipeline and writes a `TurnLog`. If the main backend
retries (e.g. on a timeout), it will get a second LLM call.

Two options for main backend:
- **Accept the duplicate cost** and de-dupe on its side (treat second
  reply as a redundant log).
- **Send a `request_id` in options** — AI backend rejects duplicates with
  a cached response if the same `request_id` is seen within a 60-second
  window. Recommended for production.

```jsonc
{
  "options": { "request_id": "main-req-abc-123", ... }
}
```

Implementation: Redis `SETNX request:{id}` with 60 s TTL. If already set,
return the stored response (also kept in Redis at `response:{id}`).

### LLM retries (inside AI backend, hidden from main backend)

`LLMClientService` retries on:
- HTTP 429 (rate limit) — exponential backoff up to 3 attempts
- HTTP 5xx — same
- network timeout — same
- non-JSON response from a JSON-mode call — single retry

After retry budget exhausted, returns `503` to main backend with `retry_after_s`.

### Validator retries (inside Orchestrator)

Already in current code via `PIPELINE_MAX_RETRIES`. Default 1 retry on
validator fail. After exhaustion, return `status: "escalate", reason: "validator_exhausted"`.

---

## 12. Observability

### What gets logged per request

`TurnLog` row (Postgres) — for AI-team analysis:
- business_id, conversation_id, contact_id, channel
- triage result, attempts (full), validator pass/fail
- intent_path, language
- tokens_in, tokens_out, models_used
- duration_ms, trace_id

Structured JSON logs (stdout) — for runtime debugging:
- request received, with `trace_id`
- each LLM call with model + tokens + latency
- final status + duration
- errors with full stack trace

### Metrics endpoints (internal only — for AI ops dashboards, NOT for tenants)

| Endpoint | Purpose |
|---|---|
| `GET /ai/v1/internal/turns?from=&to=&business_id=` | recent TurnLog rows |
| `GET /ai/v1/internal/stats/p95-latency` | overall p50/p95/p99 latency |
| `GET /ai/v1/internal/stats/escalation-rate` | what % of replies escalate |
| `GET /ai/v1/internal/stats/validator-pass-rate` | first-try pass rate |

Behind the same `INTERNAL_API_TOKEN`. Used by AI engineers, not tenants.
**Tenant-facing metrics are computed and exposed by the main backend** —
either by querying our `/turns` endpoint and aggregating, or by reading
its own analytics tables.

---

## 13. Failure modes & graceful degradation

| Failure | What AI backend does | What main backend should do |
|---|---|---|
| Redis down | Falls back to compiling prompt on every request (slow but correct) | Nothing |
| Postgres down | Returns `503` immediately | Treat as transient, retry once |
| OpenRouter timeout | Internal retry; if exhausted, returns `503` with `retry_after_s` | Wait + retry; if still failing, escalate to human |
| Unknown `business_id` | Returns `404` | Surface as a bug — main backend should never send unknown ids |
| Malformed request body | Returns `422` with issues array | Surface as a bug — main backend should validate before sending |
| Pipeline takes > 30 s | Internal timeout, returns `503` | Treat as escalation |

---

## 14. Implementation plan (concrete order)

Each step is a working slice. Don't move on until the previous one is
end-to-end testable.

### Step 1 — Schema reset
- Drop `Lead` and `Message` models from `prisma/schema.prisma`.
- Add `BusinessProfile` model (as in §7).
- Update `TurnLog` to include `business_id`, `conversation_id`, `contact_id`,
  `channel`, `status`, `trace_id`, `tokens_in`, `tokens_out`, model fields.
- Run `pnpm prisma migrate dev --name ai_service_schema`.

### Step 2 — Redis
- Add Redis to `docker-compose.yml`.
- `pnpm add ioredis`.
- Add `REDIS_URL` to `EnvSchema`.
- Build `src/cache/redis.client.ts` and `cache.module.ts`.

### Step 3 — Business profile management
- Build `BusinessProfileService` (upsert/get/delete + cache invalidation).
- Build `SystemPromptCompiler` (pure function, snapshot tested).
- Build `PromptCacheService` (Redis get/set/invalidate).
- Build `BusinessesController` exposing `PUT /ai/v1/businesses/{id}`
  and `DELETE /ai/v1/businesses/{id}`.
- Add `InternalTokenGuard` globally with `@Public` on health.

### Step 4 — Strip the old chat path
- Delete `src/chat/`, `src/history/`, `src/pipeline/kb/`,
  `src/pipeline/corpus.service.ts`, `src/pipeline/prompts/*`.
- Remove their providers from `app.module.ts` / `pipeline.module.ts`.
- Confirm `pnpm build` still passes (it won't yet — see next step).

### Step 5 — Refactor pipeline services to accept `ContextPacket`
- Define `ContextPacket` in `src/common/types/`:
  ```ts
  interface ContextPacket {
    business_id: string;
    profile: BusinessProfile;
    systemPrompt: string;          // compiled
    history: HistoryMessage[];
    contact_id: string;
    channel: string;
    trace_id?: string;
  }
  ```
- Rewrite `TriageService.callTriage()` to take `ContextPacket + currentMessage`.
- Same for `GeneratorService` and `ValidatorService`.
- Replace KB-file lookups inside these services with `ctx.profile` reads.

### Step 6 — New pipeline checkers
- `HoursService.isWithinHours(profile)` (use `luxon` for timezones).
- `EscalationRulesService.check(message, history, profile)`.
- `ToneCheckerService.check(reply, profile)`.
- `SafetyFilterService.check(reply)`.
- `ResponseCleanerService.clean(raw)`.
- `PromptAssemblerService.assemble(ctx, triage, message, hint?)`.

### Step 7 — `LLMClientService` wrapper
- Wrap `OpenRouterClient` with retry-with-exponential-backoff.
- Add per-call structured logging: model, latency, tokens, business_id.
- Throw typed errors: `LLMTimeoutError`, `LLMRateLimitError`, `LLMServerError`.

### Step 8 — Orchestrator update
- Update `PipelineOrchestratorService.runWithValidation()` to also call
  `ToneCheckerService` and `SafetyFilterService` alongside the existing
  validator. Compose `failureHint` from all three.

### Step 9 — `ReplyService` and the public endpoint
- `ContextLoaderService.load(business_id, history)`:
  - Redis GET `prompt:{business_id}` (compile + cache on miss)
  - Redis or Postgres GET profile
  - Return `ContextPacket`
- `ReplyService.handle(req: ReplyRequest) → ReplyResponse`:
  1. Load context.
  2. `HoursService.isWithinHours` → short-circuit if false.
  3. Triage.
  4. Escalation rules check.
  5. Orchestrator.runWithValidation.
  6. Write TurnLog.
  7. Return response.
- `ReplyController.create(POST /ai/v1/reply)`.
- `ReplyController.stream(POST /ai/v1/reply/stream)`.

### Step 10 — Idempotency
- Add `request_id` handling in `ReplyService`: Redis-backed dedupe with
  60 s TTL.

### Step 11 — Internal metrics endpoints
- `GET /ai/v1/internal/turns`, `/stats/p95-latency`, etc.
- All behind `InternalTokenGuard`.

### Step 12 — Hardening
- Global `ValidationPipe` already exists — confirm `ReplyRequest` DTO
  uses `class-validator` decorators.
- Add a request-size limit (e.g. 256 KB) to prevent oversized history.
- Add per-business rate limiting via Redis (e.g. 100 req/s) if needed.

### Step 13 — Cutover
- Main backend deploys with the new client.
- Run both old and new endpoints in parallel for a week.
- Delete old `POST /api/chat` route once main backend traffic is fully on
  `/ai/v1/reply`.

---

## 15. Environment variables (final list for this service)

| Variable | Required | Example | Purpose |
|---|:---:|---|---|
| `PORT` | no | `8000` | HTTP port |
| `DATABASE_URL` | yes | `postgresql://...` | Postgres |
| `REDIS_URL` | yes | `redis://localhost:6379` | Redis |
| `OPENROUTER_API_KEY` | yes | `sk-or-...` | LLM provider |
| `PIPELINE_TRIAGE_MODEL` | no | `anthropic/claude-haiku-4.5` | model id |
| `PIPELINE_GENERATOR_MODEL` | no | `anthropic/claude-sonnet-4.6` | model id |
| `PIPELINE_VALIDATOR_MODEL` | no | `anthropic/claude-haiku-4.5` | model id |
| `PIPELINE_*_TIMEOUT_MS` | no | `4500`/`10000`/`4500` | per-stage timeout |
| `PIPELINE_MAX_RETRIES` | no | `1` | validator retry budget |
| `INTERNAL_API_TOKEN` | yes | `<32+ random bytes hex>` | shared with main backend |
| `MAX_HISTORY_TURNS` | no | `10` | trim incoming history |
| `MAX_REQUEST_BYTES` | no | `262144` | body size limit |

Generate the internal token once:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put the same value in main backend's env.

---

## 16. What to delete vs. keep — checklist

### Delete
- [ ] `src/chat/` (controller + stream service)
- [ ] `src/history/` (lead + history services)
- [ ] `src/pipeline/kb/` (KB JSON files)
- [ ] `src/pipeline/prompts/` (markdown KB prompts)
- [ ] `src/pipeline/corpus.service.ts`
- [ ] `src/pipeline/prompts.service.ts` (replaced by `SystemPromptCompiler`)
- [ ] `Lead` and `Message` Prisma models
- [ ] `nest-cli.json` asset includes for `pipeline/prompts/*.md` and `pipeline/kb/*.json`
- [ ] `KB_FILE` env var

### Keep / refactor
- [x] `src/config/` — add new vars
- [x] `src/prisma/` — same Prisma 7 + pg adapter setup
- [x] `src/pipeline/triage.service.ts` — refactor signature
- [x] `src/pipeline/generator.service.ts` — refactor signature
- [x] `src/pipeline/validator.service.ts` — refactor signature
- [x] `src/pipeline/orchestrator.service.ts` — add new checkers
- [x] `src/pipeline/openrouter.client.ts` — keep as the low-level driver
- [x] `src/pipeline/metrics.service.ts` — simplify, scope to TurnLog writes
- [x] `src/health/` — keep

### New
- [ ] `src/cache/`
- [ ] `src/business/`
- [ ] `src/reply/`
- [ ] `src/auth/`
- [ ] new pipeline services (hours, escalation, tone, safety, prompt-assembler,
      response-cleaner, llm-client)

---

## 17. What the main backend has to do

For completeness — what the main-backend team needs to build to integrate
with this AI service. (You don't write this code; they do.)

1. **Profile sync.** Whenever a tenant edits their business profile in the
   main backend UI, call `PUT /ai/v1/businesses/{business_id}` with the
   new full profile. Don't try to send a diff.

2. **Tenant deletion.** When a tenant offboards, call
   `DELETE /ai/v1/businesses/{business_id}`.

3. **Reply pipeline.** For every inbound customer message:
   - load the last N (default 10) turns from your conversation table
   - check if the conversation is paused for operator handover
   - if not, call `POST /ai/v1/reply` with the message + history
   - on `replied`: send the reply through the channel + log it
   - on `escalate`: send the suggested handoff message + push to your
     operator queue + set `ai_paused = true` on the conversation
   - on `outside_hours`: send the reply, no operator routing
   - on `503`: wait + retry once, then escalate

4. **`request_id`.** Generate one per inbound channel message and pass it
   in `options.request_id`. Lets the AI backend de-dupe if you retry.

5. **`trace_id`.** Pass your existing request trace id in `options.trace_id`
   so logs across services correlate.

That's the full contract.

---

## 18. The single first thing to do tomorrow

1. Open `prisma/schema.prisma`.
2. Delete `Lead` and `Message`.
3. Add `BusinessProfile` (§7).
4. Run `pnpm prisma migrate dev --name ai_service_schema`.
5. Move to Step 2 (Redis).

Everything else cascades from those four lines of work.
