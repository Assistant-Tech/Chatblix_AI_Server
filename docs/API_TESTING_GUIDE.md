# Chatblix API Testing Guide

Complete reference for every endpoint across **AI Backend** (port 8000) and **Main Backend** (port 3000), including request/response shapes and a step-by-step Postman walkthrough.

---

## Table of Contents

1. [Architecture recap](#1-architecture-recap)
2. [Prerequisites & environment setup](#2-prerequisites--environment-setup)
3. [AI Backend endpoints](#3-ai-backend-endpoints)
   - [GET /ai/v1/health](#31-get-aiv1health)
   - [PUT /ai/v1/businesses/:id](#32-put-aiv1businessesid)
   - [DELETE /ai/v1/businesses/:id](#33-delete-aiv1businessesid)
   - [POST /ai/v1/reply](#34-post-aiv1reply)
   - [POST /ai/v1/reply/stream](#35-post-aiv1replystream)
   - [GET /ai/v1/internal/turns](#36-get-aiv1internalturns)
   - [GET /ai/v1/internal/stats/p95-latency](#37-get-aiv1internalstatsp95-latency)
   - [GET /ai/v1/internal/stats/escalation-rate](#38-get-aiv1internalstatsescalation-rate)
   - [GET /ai/v1/internal/stats/validator-pass-rate](#39-get-aiv1internalstatsvalidator-pass-rate)
4. [Main Backend — AI endpoints](#4-main-backend--ai-endpoints)
   - [GET /tenant/business-profile](#41-get-tenantbusiness-profile)
   - [PUT /tenant/business-profile](#42-put-tenantbusiness-profile)
   - [PATCH /tenant/business-profile/enable](#43-patch-tenantbusiness-profileenable)
   - [GET /tenant/business-profile/sync-status](#44-get-tenantbusiness-profilesync-status)
   - [GET /tenant/business-profile/readiness](#45-get-tenantbusiness-profilereadiness)
   - [GET /ai/conversations/paused](#46-get-aiconversationspaused)
   - [POST /ai/conversations/:conversationId/pause](#47-post-aiconversationsconversationidpause)
   - [POST /ai/conversations/:conversationId/resume](#48-post-aiconversationsconversationidresume)
   - [GET /tenant/ai-usage](#49-get-tenantai-usage)
5. [Postman step-by-step guide](#5-postman-step-by-step-guide)
6. [Reference: full BusinessProfile body](#6-reference-full-businessprofile-body)
7. [Error codes quick reference](#7-error-codes-quick-reference)

---

## 1. Architecture recap

```
Main Backend (port 3000)          AI Backend (port 8000)
────────────────────────          ─────────────────────────
Tenants, channels, messages   →   PUT  /ai/v1/businesses/:id    (profile sync on save)
Operator dashboard            →   POST /ai/v1/reply              (per inbound message)
Offboarding flow              →   DELETE /ai/v1/businesses/:id   (tenant delete)
Observability (AI team only)  ←   GET /ai/v1/internal/*
```

Two separate Postgres databases. Two separate Redis instances. Both share one `INTERNAL_API_TOKEN`.

---

## 2. Prerequisites & environment setup

### Services running

```bash
# AI backend (port 8000)
cd /home/priyanshu/projects/ai-backend
docker compose up -d   # starts Postgres + Redis
pnpm start:dev

# Main backend (port 3000)
cd /home/priyanshu/projects/main-backend
docker compose up -d
pnpm start:dev
```

### Postman environment variables

Create a Postman environment called **Chatblix Local** with these variables:

| Variable | Value | Notes |
|---|---|---|
| `AI_URL` | `http://localhost:8000/ai/v1` | AI backend base |
| `MB_URL` | `http://localhost:3000` | Main backend base |
| `INTERNAL_TOKEN` | *(value from ai-backend `.env` → `INTERNAL_API_TOKEN`)* | Shared bearer token |
| `JWT_TOKEN` | *(obtained after login — see §5)* | For main backend requests |
| `TENANT_ID` | *(UUID of your test tenant)* | Filled in during walkthrough |
| `CONVERSATION_ID` | *(UUID of a test conversation)* | Filled in during walkthrough |

### Auth rules

| Service | Protected by | Header |
|---|---|---|
| AI backend (all except `/health`) | `INTERNAL_API_TOKEN` bearer | `Authorization: Bearer {{INTERNAL_TOKEN}}` |
| Main backend | JWT from login | `Authorization: Bearer {{JWT_TOKEN}}` |

---

## 3. AI Backend endpoints

All routes are prefixed `/ai/v1`. Server: `http://localhost:8000`.

---

### 3.1 GET /ai/v1/health

**Purpose.** Liveness check. No auth required. Used by load balancers and the main backend circuit breaker.

**Request**
```
GET http://localhost:8000/ai/v1/health
```
No headers, no body.

**Response 200**
```json
{
  "status": "ok",
  "uptime_s": 3721,
  "version": "0.1.0"
}
```

---

### 3.2 PUT /ai/v1/businesses/:id

**Purpose.** Create or update a tenant's business profile on the AI side. Called automatically by the main backend every time a tenant saves their profile from the dashboard. Also the way to seed a fresh tenant for the first time.

After a successful PUT:
- The profile is persisted in AI backend's Postgres.
- `version` is incremented (starts at 1).
- Redis keys `prompt:{id}` and `profile:{id}` are invalidated so the next `/reply` call compiles a fresh system prompt.

**Request**
```
PUT http://localhost:8000/ai/v1/businesses/{{TENANT_ID}}
Authorization: Bearer {{INTERNAL_TOKEN}}
Content-Type: application/json

{ ...BusinessProfile body — see §6 for full example... }
```

**Minimal valid body**
```json
{
  "name": "Test Shop",
  "description": "A test business.",
  "language": "en",
  "tone": {
    "style": "friendly",
    "persona_name": "Alex",
    "do": ["greet warmly", "be concise"],
    "dont": ["use slang", "make price guarantees"]
  },
  "hours": {
    "timezone": "Asia/Kathmandu",
    "schedule": [
      { "day": "Monday", "open": "09:00", "close": "18:00" },
      { "day": "Tuesday", "open": "09:00", "close": "18:00" },
      { "day": "Wednesday", "open": "09:00", "close": "18:00" },
      { "day": "Thursday", "open": "09:00", "close": "18:00" },
      { "day": "Friday", "open": "09:00", "close": "18:00" }
    ],
    "holiday_message": "We are closed today. We'll be back on the next working day."
  },
  "faqs": [
    {
      "question": "What are your delivery times?",
      "answer": "We deliver within 2-3 working days across Kathmandu."
    }
  ],
  "policies": {
    "return_policy": "Returns accepted within 7 days with receipt.",
    "delivery_policy": "Free delivery above NPR 2000.",
    "payment_methods": ["cash", "eSewa", "Khalti"]
  },
  "escalation": {
    "triggers": ["refund", "complaint", "damaged", "wrong item"],
    "handoff_message": "Let me connect you with our support team right away."
  }
}
```

**Response 200**
```json
{
  "id": "{{TENANT_ID}}",
  "version": 1,
  "updated_at": "2026-05-18T10:30:00.000Z"
}
```

**Validation constraints (will cause 422 if violated)**

| Field | Rule |
|---|---|
| `tone.style` | Must be `formal`, `friendly`, or `casual` |
| `hours.schedule[].day` | Must be full weekday name: `Monday`…`Sunday` |
| `hours.schedule[].open` / `.close` | Must be HH:MM 24-hour format, e.g. `"09:00"` |
| `tone.do` / `tone.dont` | Max 50 items each |
| `faqs` | Max 200 items |
| `product_catalog` | Max 500 items (optional) |
| `current_offers` | Max 20 items (optional) |
| `locations` | Max 50 items (optional) |
| Unknown top-level keys | Rejected — `forbidNonWhitelisted: true` |

---

### 3.3 DELETE /ai/v1/businesses/:id

**Purpose.** Soft-delete a business profile. Sets `active = false` on the row in AI backend's Postgres and invalidates caches. Any subsequent `/reply` for that `business_id` returns 404. Idempotent — deleting an already-inactive profile returns 204.

**Request**
```
DELETE http://localhost:8000/ai/v1/businesses/{{TENANT_ID}}
Authorization: Bearer {{INTERNAL_TOKEN}}
```
No body.

**Response 204** (no body)

**Response 404** — only if the `id` was never pushed at all.

---

### 3.4 POST /ai/v1/reply

**Purpose.** The core pipeline endpoint. Takes an inbound customer message + conversation history, runs the full AI pipeline, and returns a structured response in one of three statuses.

**Pipeline stages (in order):**
1. Load profile from Redis cache (or Postgres on miss) — compiles system prompt if not cached.
2. **Hours check** — if current time is outside `profile.hours.schedule`, returns `outside_hours` immediately (no LLM call).
3. **Triage** — Claude Haiku classifies intent, detects language, extracts structured data.
4. **Escalation rules** — checks message against `profile.escalation.triggers` (case-insensitive word match). If matched, returns `escalate` immediately (no generator call).
5. **Generator** — Claude Sonnet produces a reply using the compiled system prompt + BUSINESS_CONTEXT JSON + history.
6. **Validator** — checks the generated reply against format rules.
7. **Tone checker** — checks against `profile.tone.dont[]`.
8. **Safety filter** — regex sweep for PII leaks (emails, phones, card numbers).
9. If validator/tone/safety fails, retries generator with a `failureHint`. After max retries, returns `escalate` with `reason: validator_exhausted`.
10. **TurnLog write** — persists the full pipeline trace to AI backend's Postgres.
11. Returns the final response.

**Request**
```
POST http://localhost:8000/ai/v1/reply
Authorization: Bearer {{INTERNAL_TOKEN}}
Content-Type: application/json
```

**Request body**
```json
{
  "business_id": "{{TENANT_ID}}",
  "conversation_id": "{{CONVERSATION_ID}}",
  "contact_id": "contact-uuid-or-phone",
  "channel": "whatsapp",
  "message": {
    "content": "Do you have the Neem Soap in stock?",
    "timestamp": "2026-05-18T10:30:00.000Z"
  },
  "history": [
    {
      "role": "user",
      "content": "Hello",
      "timestamp": "2026-05-18T10:29:00.000Z"
    },
    {
      "role": "assistant",
      "content": "Hi! How can I help you today?",
      "timestamp": "2026-05-18T10:29:05.000Z"
    }
  ],
  "options": {
    "trace_id": "my-trace-abc123",
    "request_id": "dedup-key-xyz789"
  }
}
```

**Field reference**

| Field | Required | Notes |
|---|---|---|
| `business_id` | Yes | Must match a previously PUT profile |
| `conversation_id` | Yes | Opaque; logged in TurnLog only |
| `contact_id` | Yes | Opaque; logged in TurnLog only |
| `channel` | Yes | `whatsapp`, `facebook`, `instagram`, `tiktok`, `web` |
| `message.content` | Yes | 1–8000 chars |
| `message.timestamp` | Yes | ISO 8601 |
| `history` | Yes | Empty array `[]` is fine; max 50 items |
| `history[].role` | Yes | `user` or `assistant` |
| `history[].timestamp` | Yes | ISO 8601, oldest first |
| `options.trace_id` | No | Propagated to TurnLog; useful for cross-service tracing |
| `options.request_id` | No | If set, deduplicates within 60s window — same `request_id` returns the first response verbatim without re-running the pipeline |
| `options.force_model` | No | Override LLM model (OpenRouter model id) |
| `options.skip_validator` | No | Skip validation step (useful for debugging) |

**Response — status: replied**
```json
{
  "status": "replied",
  "reply": "Yes, Neem Soap is currently in stock at NPR 350.",
  "metadata": {
    "triage": {
      "intent": "product_inquiry",
      "sentiment": "neutral",
      "language": "en"
    },
    "attempts": 1,
    "validator_pass": true,
    "model_used": "anthropic/claude-sonnet-4-6",
    "tokens_in": 1240,
    "tokens_out": 87,
    "latency_ms": 1823,
    "trace_id": "my-trace-abc123"
  }
}
```

**Response — status: escalate**
```json
{
  "status": "escalate",
  "reason": "keyword_match",
  "suggested_handoff_message": "Let me connect you with our support team right away.",
  "metadata": {
    "triage": {
      "intent": "complaint",
      "language": "en"
    },
    "attempts": 0,
    "latency_ms": 22,
    "trace_id": "my-trace-abc123"
  }
}
```

`reason` values:
- `keyword_match` — message matched a trigger in `profile.escalation.triggers`
- `triage_handoff` — triage LLM flagged `handoff_required`
- `validator_exhausted` — generator retries used up without passing validation

**Response — status: outside_hours**
```json
{
  "status": "outside_hours",
  "reply": "We are closed today. We'll be back on the next working day.",
  "metadata": {
    "latency_ms": 4,
    "trace_id": "my-trace-abc123"
  }
}
```

**Idempotency (request_id)**

If you pass `options.request_id`, the first response is cached in Redis for 60 seconds. Any subsequent call with the same `request_id` within that window returns the exact same response (including the original `trace_id` and `latency_ms`) without touching the LLM. This is how the main backend prevents duplicate replies on webhook retries.

---

### 3.5 POST /ai/v1/reply/stream

**Purpose.** Streaming variant of the reply pipeline. Returns Server-Sent Events. Used by web widget clients that want to render tokens as they arrive.

Same request body as `POST /ai/v1/reply`.

**Response** — `Content-Type: text/event-stream`

```
event: token
data: {"type":"token","delta":"Yes"}

event: token
data: {"type":"token","delta":", Neem Soap is"}

event: token
data: {"type":"token","delta":" currently in stock."}

event: done
data: {"type":"done","response":{"status":"replied","reply":"Yes, Neem Soap is currently in stock.","metadata":{...}}}
```

If an error occurs mid-stream:
```
event: error
data: {"message":"business_not_found"}
```

**Note:** Streaming does NOT support request_id deduplication (token replay would require storing all chunks).

**Testing in Postman:** Postman can consume SSE via a standard POST request — the response body will show the raw SSE text. For proper streaming preview, use `curl`:
```bash
curl -N -X POST http://localhost:8000/ai/v1/reply/stream \
  -H "Authorization: Bearer $INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"business_id":"...","conversation_id":"...","contact_id":"...","channel":"web","message":{"content":"Hi","timestamp":"2026-05-18T10:00:00Z"},"history":[]}'
```

---

### 3.6 GET /ai/v1/internal/turns

**Purpose.** Paginated view of raw TurnLog rows. AI-team observability only — do not expose to tenants. Default window: last 24 hours.

**Request**
```
GET http://localhost:8000/ai/v1/internal/turns?limit=10&business_id={{TENANT_ID}}
Authorization: Bearer {{INTERNAL_TOKEN}}
```

**Query params**

| Param | Required | Default | Notes |
|---|---|---|---|
| `from` | No | now − 24h | ISO 8601 lower bound |
| `to` | No | now | ISO 8601 upper bound |
| `business_id` | No | — | Filter to one tenant |
| `limit` | No | 100 | Max 500 |

**Response 200**
```json
[
  {
    "id": "...",
    "business_id": "{{TENANT_ID}}",
    "conversation_id": "...",
    "contact_id": "...",
    "channel": "whatsapp",
    "ts": "2026-05-18T10:30:01.000Z",
    "status": "replied",
    "triage": { "intent": "product_inquiry", "language": "en" },
    "attempts": 1,
    "validator_pass": true,
    "retry_count": 0,
    "high_severity_violations": 0,
    "intent_path": "direct_factual",
    "language": "en",
    "shipped": "<reply>Yes, Neem Soap is in stock.</reply>",
    "duration_ms": 1823,
    "trace_id": "my-trace-abc123",
    "model_triage": "anthropic/claude-haiku-4-5",
    "model_generator": "anthropic/claude-sonnet-4-6",
    "model_validator": "anthropic/claude-haiku-4-5",
    "tokens_in": 1240,
    "tokens_out": 87
  }
]
```

---

### 3.7 GET /ai/v1/internal/stats/p95-latency

**Purpose.** p50 / p95 / p99 percentile latency of completed pipeline runs over a time window. Use this to detect LLM slowdowns.

**Request**
```
GET http://localhost:8000/ai/v1/internal/stats/p95-latency?business_id={{TENANT_ID}}
Authorization: Bearer {{INTERNAL_TOKEN}}
```

Query params: `from`, `to`, `business_id` (all optional, same as `/turns`).

**Response 200**
```json
{
  "window_from": "2026-05-17T10:30:00.000Z",
  "window_to": "2026-05-18T10:30:00.000Z",
  "count": 142,
  "p50_ms": 1340,
  "p95_ms": 3870,
  "p99_ms": 5210
}
```

`null` values for percentiles mean no data in the window.

---

### 3.8 GET /ai/v1/internal/stats/escalation-rate

**Purpose.** What fraction of pipeline runs resulted in escalation. High escalation rate (>30%) usually signals a profile configuration issue (too many triggers, or a bad triage system prompt).

**Request**
```
GET http://localhost:8000/ai/v1/internal/stats/escalation-rate
Authorization: Bearer {{INTERNAL_TOKEN}}
```

**Response 200**
```json
{
  "window_from": "2026-05-17T10:30:00.000Z",
  "window_to": "2026-05-18T10:30:00.000Z",
  "total": 142,
  "numerator": 8,
  "rate": 0.0563
}
```

`rate` is a decimal (0–1). Multiply by 100 for percentage.

---

### 3.9 GET /ai/v1/internal/stats/validator-pass-rate

**Purpose.** What fraction of pipeline runs had the generator pass the validator on the first or second attempt. Low rate (<70%) usually means the generator system prompt needs tuning.

**Request**
```
GET http://localhost:8000/ai/v1/internal/stats/validator-pass-rate
Authorization: Bearer {{INTERNAL_TOKEN}}
```

**Response 200**
```json
{
  "window_from": "2026-05-17T10:30:00.000Z",
  "window_to": "2026-05-18T10:30:00.000Z",
  "total": 134,
  "numerator": 127,
  "rate": 0.9478
}
```

---

## 4. Main Backend — AI endpoints

All routes require a JWT bearer token from the logged-in operator/admin. Server: `http://localhost:3000`.

The main backend's global prefix is not `/api` — routes are mounted at their exact paths shown below.

---

### 4.1 GET /tenant/business-profile

**Purpose.** Fetch the current tenant's business profile. Creates a blank profile row with safe defaults if one doesn't exist yet (does NOT sync to AI backend — `aiEnabled` defaults to `false`).

**Request**
```
GET http://localhost:3000/tenant/business-profile
Authorization: Bearer {{JWT_TOKEN}}
```

**Response 200**
```json
{
  "success": true,
  "message": "Business profile retrieved successfully",
  "data": {
    "id": "...",
    "tenantId": "{{TENANT_ID}}",
    "aiEnabled": false,
    "name": "My Shop",
    "description": "",
    "language": "en",
    "tone": { "style": "friendly", "persona_name": "Assistant", "do": [], "dont": [] },
    "hours": { "timezone": "Asia/Kathmandu", "schedule": [], "holiday_message": "We are currently unavailable." },
    "faqs": [],
    "policies": { "return_policy": "", "delivery_policy": "", "payment_methods": [] },
    "escalation": { "triggers": [], "handoff_message": "Let me connect you to a teammate." },
    "aiBackendVersion": null,
    "lastSyncedAt": null,
    "lastSyncError": null,
    "createdAt": "2026-05-18T09:00:00.000Z",
    "updatedAt": "2026-05-18T09:00:00.000Z"
  }
}
```

---

### 4.2 PUT /tenant/business-profile

**Purpose.** Save the tenant's full business profile. On success:
1. Upserts the row in main backend's Postgres.
2. Immediately calls `PUT /ai/v1/businesses/:tenantId` on the AI backend (synchronously awaited).
3. Persists `aiBackendVersion`, `lastSyncedAt`, and clears `lastSyncError` on success; or stores the error message in `lastSyncError` on failure (the local row is still saved).

**Request**
```
PUT http://localhost:3000/tenant/business-profile
Authorization: Bearer {{JWT_TOKEN}}
Content-Type: application/json

{ ...same BusinessProfile body as §3.2... }
```

**Response 200**
```json
{
  "success": true,
  "message": "Business profile saved and synced",
  "data": {
    "id": "...",
    "tenantId": "{{TENANT_ID}}",
    "aiEnabled": false,
    "aiBackendVersion": 1,
    "lastSyncedAt": "2026-05-18T10:30:00.000Z",
    "lastSyncError": null,
    ...full profile fields...
  }
}
```

**If AI backend sync fails** (network error, validation error): the main backend still returns 200 with the locally-saved profile, but `lastSyncError` will contain the error message. Check `GET /tenant/business-profile/sync-status` to see drift.

---

### 4.3 PATCH /tenant/business-profile/enable

**Purpose.** Toggle the AI master switch for this tenant. When enabling (`enabled: true`), the service first validates the profile is "complete enough" and re-pushes it to the AI backend to ensure the cache is fresh. When disabling, it flips the flag locally — the AI backend profile is left intact (so re-enabling doesn't require a re-push).

**Readiness requirements (will 400 if missing when enabling):**
- `tone.persona_name` is non-empty
- `hours.schedule` has at least one entry
- `escalation.handoff_message` is non-empty
- At least one of `faqs`, `policies.return_policy`, or `policies.delivery_policy` is populated

**Request — enable**
```
PATCH http://localhost:3000/tenant/business-profile/enable
Authorization: Bearer {{JWT_TOKEN}}
Content-Type: application/json

{ "enabled": true }
```

**Request — disable**
```
PATCH http://localhost:3000/tenant/business-profile/enable
Authorization: Bearer {{JWT_TOKEN}}
Content-Type: application/json

{ "enabled": false }
```

**Response 200**
```json
{
  "success": true,
  "message": "AI assistant enabled",
  "data": {
    "id": "...",
    "aiEnabled": true,
    "aiBackendVersion": 2,
    "lastSyncedAt": "2026-05-18T10:35:00.000Z",
    ...
  }
}
```

**Response 400 (profile not ready)**
```json
{
  "success": false,
  "message": "Profile is not ready to enable AI",
  "data": {
    "missing": ["hours.schedule", "escalation.handoff_message"]
  }
}
```

---

### 4.4 GET /tenant/business-profile/sync-status

**Purpose.** Check whether the local profile is in sync with the AI backend. Shows the last synced version, timestamp, and any sync error. Used by the dashboard to show a "Sync failed" warning banner.

**Request**
```
GET http://localhost:3000/tenant/business-profile/sync-status
Authorization: Bearer {{JWT_TOKEN}}
```

**Response 200 — synced**
```json
{
  "success": true,
  "message": "Sync status retrieved successfully",
  "data": {
    "aiBackendVersion": 3,
    "lastSyncedAt": "2026-05-18T10:35:00.000Z",
    "lastSyncError": null
  }
}
```

**Response 200 — drift detected**
```json
{
  "success": true,
  "message": "Sync status retrieved successfully",
  "data": {
    "aiBackendVersion": 2,
    "lastSyncedAt": "2026-05-17T08:00:00.000Z",
    "lastSyncError": "connect ECONNREFUSED 127.0.0.1:8000"
  }
}
```

Fix: retry `PUT /tenant/business-profile` or restart AI backend and retry.

---

### 4.5 GET /tenant/business-profile/readiness

**Purpose.** Pre-flight check for the dashboard's "Enable AI" button. Returns which required fields are missing so the UI can show actionable hints.

**Request**
```
GET http://localhost:3000/tenant/business-profile/readiness
Authorization: Bearer {{JWT_TOKEN}}
```

**Response 200 — ready**
```json
{
  "success": true,
  "message": "Readiness check completed",
  "data": {
    "ready": true,
    "missing": []
  }
}
```

**Response 200 — not ready**
```json
{
  "success": true,
  "message": "Readiness check completed",
  "data": {
    "ready": false,
    "missing": [
      "hours.schedule",
      "tone.persona_name"
    ]
  }
}
```

---

### 4.6 GET /ai/conversations/paused

**Purpose.** Paginated list of conversations where `aiPaused = true` and `status = PENDING`. Powers the operator's "AI-escalated queue" view on the dashboard.

**Request**
```
GET http://localhost:3000/ai/conversations/paused?limit=25
Authorization: Bearer {{JWT_TOKEN}}
```

**Query params**

| Param | Required | Default | Notes |
|---|---|---|---|
| `cursor` | No | — | UUID of last conversation from previous page (cursor pagination) |
| `limit` | No | 25 | Max 100 |

**Response 200**
```json
{
  "success": true,
  "message": "Paused conversations retrieved successfully",
  "data": {
    "conversations": [
      {
        "id": "{{CONVERSATION_ID}}",
        "tenantId": "{{TENANT_ID}}",
        "status": "PENDING",
        "aiPaused": true,
        "aiPausedReason": "keyword_match",
        "aiPausedAt": "2026-05-18T10:30:05.000Z",
        "lastMessageAt": "2026-05-18T10:30:00.000Z",
        ...
      }
    ],
    "nextCursor": "next-page-uuid-or-null"
  }
}
```

---

### 4.7 POST /ai/conversations/:conversationId/pause

**Purpose.** Operator manually takes over a conversation. Sets `aiPaused = true` on the conversation so the AI stops replying. Conversation moves to `PENDING` status if it was `OPEN`. Emits a `inbox:conversation.ai_escalated` websocket event. Idempotent — if already paused, returns the existing state.

**When to use:** Operator opens a conversation in the dashboard and clicks "Take over" — the frontend should call this immediately to prevent an in-flight AI reply from racing the operator.

**Request**
```
POST http://localhost:3000/ai/conversations/{{CONVERSATION_ID}}/pause
Authorization: Bearer {{JWT_TOKEN}}
Content-Type: application/json

{ "reason": "operator_takeover" }
```

Body is optional — `reason` defaults to `"operator_takeover"`.

**Response 200**
```json
{
  "success": true,
  "message": "AI paused on conversation",
  "data": {
    "id": "{{CONVERSATION_ID}}",
    "aiPaused": true,
    "aiPausedReason": "operator_takeover",
    "aiPausedAt": "2026-05-18T11:00:00.000Z",
    "status": "PENDING"
  }
}
```

---

### 4.8 POST /ai/conversations/:conversationId/resume

**Purpose.** Release the conversation back to AI. Sets `aiPaused = false`, clears `aiPausedReason` and `aiPausedAt`, and moves status back to `OPEN`. The next inbound customer message will go through AI again.

**Request**
```
POST http://localhost:3000/ai/conversations/{{CONVERSATION_ID}}/resume
Authorization: Bearer {{JWT_TOKEN}}
```
No body.

**Response 200**
```json
{
  "success": true,
  "message": "AI resumed on conversation",
  "data": {
    "id": "{{CONVERSATION_ID}}",
    "aiPaused": false,
    "aiPausedReason": null,
    "aiPausedAt": null,
    "status": "OPEN"
  }
}
```

---

### 4.9 GET /tenant/ai-usage

**Purpose.** Aggregated AI usage statistics for billing rollups and tenant-facing dashboards. Bucketed by day / week / month. Sourced from the `ai_usage_events` table written by `AiHandoffService` on every pipeline completion.

**Request**
```
GET http://localhost:3000/tenant/ai-usage?group_by=day&from=2026-05-01T00:00:00Z&to=2026-05-18T00:00:00Z
Authorization: Bearer {{JWT_TOKEN}}
```

**Query params**

| Param | Required | Default | Notes |
|---|---|---|---|
| `from` | No | now − 30d | ISO 8601 datetime |
| `to` | No | now | ISO 8601 datetime |
| `group_by` | No | `day` | `day`, `week`, or `month` |

Max window: 366 days. `from` must be before `to`.

**Response 200**
```json
{
  "success": true,
  "message": "AI usage retrieved successfully",
  "data": {
    "window": {
      "from": "2026-05-01T00:00:00.000Z",
      "to": "2026-05-18T00:00:00.000Z",
      "groupBy": "day"
    },
    "totals": {
      "replies": 248,
      "escalations": 14,
      "outsideHours": 31,
      "tokensIn": 318420,
      "tokensOut": 24680
    },
    "byBucket": [
      {
        "bucket": "2026-05-01T00:00:00.000Z",
        "replies": 12,
        "escalations": 1,
        "outsideHours": 2,
        "tokensIn": 15400,
        "tokensOut": 1200
      }
    ]
  }
}
```

---

## 5. Postman step-by-step guide

Follow these steps in order for a complete end-to-end test.

---

### Step 1 — Set up the environment

1. Open Postman → Environments → New.
2. Name it `Chatblix Local`.
3. Add these variables (all as **Current value**):

```
AI_URL          = http://localhost:8000/ai/v1
MB_URL          = http://localhost:3000
INTERNAL_TOKEN  = <paste value from ai-backend .env INTERNAL_API_TOKEN>
```

4. Leave `JWT_TOKEN`, `TENANT_ID`, `CONVERSATION_ID` blank for now — you'll fill them in.

---

### Step 2 — Verify AI backend is running

**Request:**
```
GET {{AI_URL}}/health
```
Expected: `{"status":"ok",...}` — if you get a connection refused, start the AI backend first.

---

### Step 3 — Log in to main backend and get a JWT

**Request:**
```
POST {{MB_URL}}/auth/login
Content-Type: application/json

{
  "email": "your@email.com",
  "password": "yourpassword"
}
```

From the response, copy `data.accessToken` and paste it as the `JWT_TOKEN` environment variable.

Also copy the `tenantId` from the JWT payload (decode it at jwt.io) and set it as `TENANT_ID`.

---

### Step 4 — Push a business profile to AI backend (directly)

This tests the AI backend in isolation.

**Request:**
```
PUT {{AI_URL}}/businesses/{{TENANT_ID}}
Authorization: Bearer {{INTERNAL_TOKEN}}
Content-Type: application/json
```

Use the full body from §6 below.

Expected response:
```json
{ "id": "{{TENANT_ID}}", "version": 1, "updated_at": "..." }
```

---

### Step 5 — Test outside_hours

Temporarily set all schedule entries to a time range that has already passed today (e.g., `"open": "01:00", "close": "02:00"`), push the profile again, then:

**Request:**
```
POST {{AI_URL}}/reply
Authorization: Bearer {{INTERNAL_TOKEN}}
Content-Type: application/json

{
  "business_id": "{{TENANT_ID}}",
  "conversation_id": "test-conv-001",
  "contact_id": "test-contact-001",
  "channel": "whatsapp",
  "message": { "content": "Hi, are you open?", "timestamp": "2026-05-18T10:00:00Z" },
  "history": []
}
```

Expected: `{"status":"outside_hours","reply":"We are closed today...","metadata":{...}}`

Restore the schedule to normal hours before the next test.

---

### Step 6 — Test escalation (keyword match, no LLM call)

**Request:**
```
POST {{AI_URL}}/reply
Authorization: Bearer {{INTERNAL_TOKEN}}
Content-Type: application/json

{
  "business_id": "{{TENANT_ID}}",
  "conversation_id": "test-conv-002",
  "contact_id": "test-contact-001",
  "channel": "whatsapp",
  "message": { "content": "I want a refund for my damaged product", "timestamp": "2026-05-18T10:00:00Z" },
  "history": []
}
```

Expected (matches "refund" and "damaged" triggers from the profile):
```json
{
  "status": "escalate",
  "reason": "keyword_match",
  "suggested_handoff_message": "Let me connect you with our support team right away.",
  "metadata": { "attempts": 0, "latency_ms": 20, ... }
}
```

`latency_ms` will be very low (no LLM call made).

---

### Step 7 — Test request_id deduplication

First call — save the response:
```
POST {{AI_URL}}/reply
Authorization: Bearer {{INTERNAL_TOKEN}}
Content-Type: application/json

{
  "business_id": "{{TENANT_ID}}",
  "conversation_id": "test-conv-003",
  "contact_id": "test-contact-001",
  "channel": "whatsapp",
  "message": { "content": "Hello!", "timestamp": "2026-05-18T10:00:00Z" },
  "history": [],
  "options": { "request_id": "dedup-test-001", "trace_id": "trace-first-call" }
}
```

Second call — immediately after, different trace_id:
```json
{
  ...same body...,
  "options": { "request_id": "dedup-test-001", "trace_id": "trace-second-call" }
}
```

Expected: both responses are **identical** — same `trace_id: "trace-first-call"`, same `latency_ms`. Only 1 TurnLog row gets written (verify via `GET /internal/turns`).

---

### Step 8 — Check the TurnLog

```
GET {{AI_URL}}/internal/turns?business_id={{TENANT_ID}}&limit=5
Authorization: Bearer {{INTERNAL_TOKEN}}
```

You should see rows for the tests in steps 5–7.

---

### Step 9 — Check latency stats

```
GET {{AI_URL}}/internal/stats/p95-latency?business_id={{TENANT_ID}}
Authorization: Bearer {{INTERNAL_TOKEN}}
```

---

### Step 10 — Test the main backend profile flow

**10a — Fetch/create profile:**
```
GET {{MB_URL}}/tenant/business-profile
Authorization: Bearer {{JWT_TOKEN}}
```

**10b — Save a full profile (syncs to AI backend automatically):**
```
PUT {{MB_URL}}/tenant/business-profile
Authorization: Bearer {{JWT_TOKEN}}
Content-Type: application/json

{ ...full body from §6... }
```

Check `aiBackendVersion` in the response — should be 1 (or incremented if you've pushed before). Check `lastSyncError` — should be `null`.

**10c — Check readiness:**
```
GET {{MB_URL}}/tenant/business-profile/readiness
Authorization: Bearer {{JWT_TOKEN}}
```

**10d — Enable AI:**
```
PATCH {{MB_URL}}/tenant/business-profile/enable
Authorization: Bearer {{JWT_TOKEN}}
Content-Type: application/json

{ "enabled": true }
```

**10e — Disable AI:**
```json
{ "enabled": false }
```

---

### Step 11 — Test operator pause/resume

You need a real `CONVERSATION_ID` for this. Get one from the inbox list:
```
GET {{MB_URL}}/inbox
Authorization: Bearer {{JWT_TOKEN}}
```

Set `CONVERSATION_ID` to any open conversation's id.

**Pause:**
```
POST {{MB_URL}}/ai/conversations/{{CONVERSATION_ID}}/pause
Authorization: Bearer {{JWT_TOKEN}}
Content-Type: application/json

{ "reason": "testing operator takeover" }
```

**List paused queue:**
```
GET {{MB_URL}}/ai/conversations/paused
Authorization: Bearer {{JWT_TOKEN}}
```

The conversation should appear in the list.

**Resume:**
```
POST {{MB_URL}}/ai/conversations/{{CONVERSATION_ID}}/resume
Authorization: Bearer {{JWT_TOKEN}}
```

---

### Step 12 — Check usage stats (requires some prior traffic)

```
GET {{MB_URL}}/tenant/ai-usage?group_by=day
Authorization: Bearer {{JWT_TOKEN}}
```

---

## 6. Reference: full BusinessProfile body

Complete example with all optional fields populated. Use this for the PUT calls in the walkthrough.

```json
{
  "name": "Fresh & More",
  "description": "Premium skincare products made from natural Himalayan ingredients, based in Kathmandu.",
  "business_type": "skincare",
  "language": "ne_rom",

  "tone": {
    "style": "friendly",
    "persona_name": "Sita",
    "do": [
      "always greet with 'Namaste' or 'hajur'",
      "use simple Romanized Nepali mixed with English",
      "recommend products by skin concern",
      "mention eSewa/Khalti payment options proactively"
    ],
    "dont": [
      "use formal medical terminology",
      "make guarantees about skin improvement timelines",
      "mention competitor brands",
      "use em-dashes or bullet-point lists in replies"
    ]
  },

  "hours": {
    "timezone": "Asia/Kathmandu",
    "schedule": [
      { "day": "Sunday",    "open": "09:00", "close": "18:00" },
      { "day": "Monday",    "open": "09:00", "close": "18:00" },
      { "day": "Tuesday",   "open": "09:00", "close": "18:00" },
      { "day": "Wednesday", "open": "09:00", "close": "18:00" },
      { "day": "Thursday",  "open": "09:00", "close": "18:00" },
      { "day": "Friday",    "open": "09:00", "close": "18:00" }
    ],
    "holiday_message": "Aaja hami banda chau. Bholi bihana 9 baje khulcha. Happy to help tomorrow!"
  },

  "faqs": [
    {
      "question": "Do you deliver outside Kathmandu?",
      "answer": "Yes, we deliver across Nepal. Inside Kathmandu valley: 2-3 days. Outside valley: 4-7 days via Prabhu Courier or Dash Courier."
    },
    {
      "question": "What is your return policy?",
      "answer": "We accept returns within 7 days if the product is unopened and in original packaging. Call us or message here for a return request."
    },
    {
      "question": "Do you have a physical store?",
      "answer": "Yes! Visit us at Newroad, Kathmandu. Open Sunday–Friday, 9AM–6PM."
    }
  ],

  "policies": {
    "return_policy": "Unopened products can be returned within 7 days with receipt. Opened products are non-returnable unless defective.",
    "delivery_policy": "Free delivery on orders above NPR 2000 within Kathmandu valley. Flat NPR 150 delivery fee for smaller orders. Outside valley charges vary by courier.",
    "payment_methods": ["cash on delivery", "eSewa", "Khalti", "bank transfer"],
    "custom": [
      "Bulk orders (10+ items) get 10% discount — contact us directly.",
      "Loyalty members get free delivery on all orders."
    ]
  },

  "escalation": {
    "triggers": [
      "refund",
      "damaged",
      "wrong item",
      "complaint",
      "not working",
      "allergic reaction",
      "side effect",
      "legal",
      "sue"
    ],
    "handoff_message": "Maaf garnu, tapailai yasto problem bhayo bhanera dukha lagyo. Hamro support team sanga connect gardinchhu — please ek chin perna garnu."
  },

  "product_catalog": [
    {
      "name": "Neem Face Wash",
      "price": 350,
      "description": "Deep-cleansing face wash with neem extract. Suitable for oily and acne-prone skin.",
      "tags": ["face wash", "neem", "oily skin", "acne"]
    },
    {
      "name": "Green Tea Glow Mask",
      "price": 550,
      "description": "Antioxidant-rich clay mask with green tea extract. Use 2x per week for best results.",
      "tags": ["mask", "green tea", "glow", "antioxidant"]
    },
    {
      "name": "Haldi Brightening Serum",
      "price": 780,
      "description": "Lightweight serum with turmeric and vitamin C. Reduces dark spots over 4-6 weeks.",
      "tags": ["serum", "turmeric", "haldi", "brightening", "vitamin C"]
    }
  ],

  "locations": [
    {
      "name": "Newroad Flagship",
      "address": "Indrachowk, Newroad, Kathmandu 44600",
      "hours": "Sun–Fri 9AM–6PM"
    }
  ],

  "current_offers": [
    {
      "title": "Dashain Special — 15% off all serums",
      "details": "Use code DASHAIN15 at checkout on our website, or mention this offer when ordering via WhatsApp.",
      "valid_until": "2026-10-31T23:59:59Z"
    }
  ],

  "high_value_threshold": 5000
}
```

---

## 7. Error codes quick reference

### AI backend

| Status | Body | Meaning |
|---|---|---|
| 401 | `{ "message": "Unauthorized" }` | Missing or invalid `INTERNAL_API_TOKEN` |
| 404 | `{ "error": "business_not_found", "business_id": "..." }` | No active profile for this id |
| 422 | `{ "message": "...", "errors": [...] }` | Validation failure — check `errors` array for field-level details |
| 413 | Body size exceeded 256 KiB | Reduce payload size |
| 503 | `{ "error": "...", "retry_after_s": 5 }` | LLM rate-limit or server error — retry after `retry_after_s` seconds |

### Main backend (AI routes)

| Status | Body | Meaning |
|---|---|---|
| 401 | JWT expired or missing | Re-login and get a fresh `accessToken` |
| 400 | `{ "data": { "missing": [...] } }` | Profile not ready to enable AI |
| 502 | `{ "message": "AI backend sync failed: ..." }` | AI backend unreachable or returned an error during profile PUT |
| 404 | Conversation not found | `conversationId` doesn't belong to this tenant |

### How the main backend handles AI backend errors

| AI backend response | Main backend behavior |
|---|---|
| 200 | Normal dispatch |
| 503 (with retry_after_s) | Retries once after the delay; if still 503, triggers `escalateOnHardFailure` |
| 400 / 422 | Permanent error — logs `lastSyncError`, no retry |
| 401 | `AiBackendUnauthorizedError` — token mismatch, escalates and alerts oncall |
| 404 | Profile out of sync — triggers re-push |
| Network timeout (>30s) | Treated as hard failure → `escalateOnHardFailure` |

`escalateOnHardFailure` always sends the tenant's `escalation.handoff_message` through the outbound queue and sets `aiPaused = true` on the conversation — so the customer always gets some reply even when AI is broken.
