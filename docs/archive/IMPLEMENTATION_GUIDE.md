# Implementation Guide — Multi-Tenant Agent Platform

This guide explains **exactly how to build** the system described in
`MULTI_TENANT_PLAN.md`. Every section is concrete: real endpoint URLs,
real database columns, real file paths inside `src/`, real example payloads.

If you read this top-to-bottom, you should be able to start coding without
guessing what goes where.

---

## Table of contents

0. [Mental model — the 3 actors](#0-mental-model--the-3-actors)
1. [The whole system in one picture](#1-the-whole-system-in-one-picture)
2. [External services you'll integrate with](#2-external-services-youll-integrate-with)
3. [Complete database schema](#3-complete-database-schema)
4. [Complete API surface](#4-complete-api-surface)
5. [End-to-end walkthrough of one real message](#5-end-to-end-walkthrough-of-one-real-message)
6. [Implementation order — what to build, in what order](#6-implementation-order)
7. [File-by-file: what each new file does](#7-file-by-file-what-each-new-file-does)
8. [Environment variables — the full list](#8-environment-variables--the-full-list)
9. [Local dev setup](#9-local-dev-setup)
10. [Sample requests you can run today](#10-sample-requests-you-can-run-today)

---

## 0. Mental model — the 3 actors

Before any code, internalise that **three different kinds of people** interact
with this system. Most confusion in multi-tenant SaaS comes from mixing them up.

| # | Actor | Who they are | What they want | How they hit your system |
|---|-------|--------------|----------------|--------------------------|
| 1 | **Tenant** | A business that signs up for Chatblix (e.g. "Fresh & More") | Configure their AI agent — name it, give it FAQs, set hours | **REST API** (`/api/tenants/...`) used by a dashboard you'll build later |
| 2 | **End-user** | The customer messaging the tenant on WhatsApp/Instagram | Get an answer to their question | **Webhooks** from Meta — you never talk to them directly |
| 3 | **Operator** | A human employee of the tenant who handles escalations | Take over conversations the AI can't | **REST API** (`/api/operator/...`) used by an operator dashboard |

Three actors → three completely separate API groups → three completely
separate auth strategies:

- Tenants → API key in `Authorization: Bearer <tenant-api-key>`
- End-users → no auth (Meta signs the webhook, you verify Meta's signature)
- Operators → JWT issued after operator login

Once this is clear, the rest of the system falls into place.

---

## 1. The whole system in one picture

```
                     ┌─────────────────────────────┐
                     │ TENANT DASHBOARD (future UI) │
                     │ — onboard, edit profile,     │
                     │   view metrics               │
                     └──────────────┬──────────────┘
                                    │ HTTPS  (Bearer tenant-api-key)
                                    ▼
┌──────────────┐         ┌───────────────────────────┐
│ End user on  │  POST   │   YOUR NESTJS BACKEND     │     ┌───────────────┐
│ WhatsApp/IG  ├────────►│  /api/webhooks/whatsapp   │────►│  Postgres     │
└──────┬───────┘ webhook │  /api/webhooks/instagram  │     │  (Prisma)     │
       │                 │  /api/tenants/*           │     └───────────────┘
       │                 │  /api/operator/*          │     ┌───────────────┐
       │  reply via      │                           │────►│  Redis        │
       │  Meta Graph API │   ┌─────────────────────┐ │     │  (cache+pubsub)│
       │◄────────────────│   │ PipelineService     │ │     └───────────────┘
       │                 │   │  ↓                  │ │     ┌───────────────┐
       │                 │   │ ContextLoader       │ │────►│ OpenRouter    │
       │                 │   │  ↓                  │ │     │ (LLM API)     │
       │                 │   │ Triage → Generator  │ │     └───────────────┘
       │                 │   │       → Validator   │ │     ┌───────────────┐
       │                 │   │  ↓                  │ │────►│ Meta Graph API│
       │                 │   │ ChannelDispatcher   │ │     │ (send replies)│
       │                 │   └─────────────────────┘ │     └───────────────┘
       │                 └────────────┬──────────────┘
       │                              │ pub: queue.new
       │                              ▼
       │                 ┌───────────────────────────┐
       └─── handoff ─────│ OPERATOR DASHBOARD (future)│
                         │ — claim, reply, resolve   │
                         └───────────────────────────┘
```

Read this picture as: **every message starts on the left (end-user), travels
through the pipeline in the middle (NestJS), and either replies back to the
end-user automatically, or surfaces in the operator dashboard for a human.**

---

## 2. External services you'll integrate with

| Service | Why | Where it's called from | Auth |
|---------|-----|------------------------|------|
| **Postgres** | Permanent storage: business profiles, conversations, queue | `PrismaService` (already exists) | `DATABASE_URL` |
| **Redis** | Hot cache for compiled prompts + pub/sub for queue notifications | New `CacheService` | `REDIS_URL` |
| **OpenRouter** | LLM calls (Triage / Generator / Validator) | `OpenRouterClient` (already exists) | `OPENROUTER_API_KEY` |
| **Meta Graph API (WhatsApp Cloud)** | Receive customer messages + send replies | `WhatsAppAdapter` | Per-tenant `META_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` |
| **Meta Graph API (Instagram Messaging)** | Same, for Instagram DMs | `InstagramAdapter` | Per-tenant `META_ACCESS_TOKEN` + `IG_USER_ID` |

### WhatsApp Cloud API — the 2 endpoints you actually need

```
# 1. Receive a message (Meta calls YOU)
POST  https://your-backend.com/api/webhooks/whatsapp
      Body: WhatsApp webhook JSON (see §4.2 for shape)
      Signature header: x-hub-signature-256 (HMAC-SHA256 of body, using APP_SECRET)

# 2. Send a reply (YOU call Meta)
POST  https://graph.facebook.com/v21.0/{phone-number-id}/messages
      Authorization: Bearer {META_ACCESS_TOKEN}
      Body: { "messaging_product": "whatsapp", "to": "<contact>", "type": "text", "text": { "body": "..." } }
```

### Instagram Messaging — same shape, different URLs

```
POST  https://your-backend.com/api/webhooks/instagram   ← Meta → you
POST  https://graph.facebook.com/v21.0/{ig-user-id}/messages   ← you → Meta
```

### Webhook verification (one-time, both platforms)

When you register the webhook URL with Meta, Meta sends a `GET` request
first to confirm you control the URL:

```
GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<YOUR_SECRET>&hub.challenge=<random>
→ respond with the value of hub.challenge (plain text, 200 OK)
```

---

## 3. Complete database schema

### What you keep from today

```
Lead          ← keep, but add business_id
Message       ← keep, but add business_id + channel + contact_id
TurnLog       ← keep, but add business_id + channel
```

### What you add

```
BusinessProfile     ← the tenant's onboarding data (T1.1)
TenantApiKey        ← API keys tenants use to call /api/tenants/*
ChannelCredential   ← per-tenant Meta tokens (WhatsApp, Instagram, etc.)
HumanQueueItem      ← escalations awaiting operator (T7.1)
Operator            ← people who can claim queue items
```

### Full Prisma schema (target end state)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

// ───── Tenants ─────────────────────────────────────────────

model BusinessProfile {
  id              String   @id @default(uuid())
  name            String
  description     String
  language        String   @default("en")        // "en" | "ne" | "hi"
  tone            Json                            // { style, persona_name, do[], dont[] }
  hours           Json                            // { timezone, schedule[], holiday_message }
  faqs            Json                            // [{ question, answer }, ...]
  policies        Json                            // { return_policy, delivery_info, payment_methods[], custom[] }
  escalation      Json                            // { triggers[], handoff_message }
  channels        String[]                        // ["whatsapp", "instagram"]
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt

  apiKeys         TenantApiKey[]
  channelCreds    ChannelCredential[]
  operators       Operator[]
  conversations   Conversation[]
  queueItems      HumanQueueItem[]
}

model TenantApiKey {
  id              String   @id @default(uuid())
  business_id     String
  key_hash        String   @unique               // store SHA-256 hash, never the raw key
  label           String                          // "production" | "staging"
  created_at      DateTime @default(now())
  revoked_at      DateTime?

  business        BusinessProfile @relation(fields: [business_id], references: [id], onDelete: Cascade)
}

model ChannelCredential {
  id                     String   @id @default(uuid())
  business_id            String
  channel                String                   // "whatsapp" | "instagram"
  access_token_encrypted String                   // encrypted at rest
  phone_number_id        String?                  // WhatsApp-specific
  ig_user_id             String?                  // Instagram-specific
  app_secret_encrypted   String                   // for signature verification
  verify_token           String                   // chosen by tenant, used during webhook setup
  created_at             DateTime @default(now())

  business               BusinessProfile @relation(fields: [business_id], references: [id], onDelete: Cascade)
  @@unique([business_id, channel])
}

// ───── Conversations ───────────────────────────────────────

model Conversation {
  id              String   @id @default(uuid())
  business_id     String
  contact_id      String                          // phone number, IG handle, email
  channel         String                          // "whatsapp" | "instagram" | ...
  last_active_at  DateTime @default(now())
  ai_paused       Boolean  @default(false)        // true while operator is handling

  business        BusinessProfile @relation(fields: [business_id], references: [id], onDelete: Cascade)
  messages        ConversationMessage[]

  @@unique([business_id, contact_id, channel])
  @@index([business_id, last_active_at])
}

model ConversationMessage {
  id              String   @id @default(uuid())
  conversation_id String
  role            String                          // "user" | "assistant" | "operator" | "system"
  content         String   @db.Text
  metadata        Json?                           // triage result, validator flags, tokens used
  timestamp       DateTime @default(now())

  conversation    Conversation @relation(fields: [conversation_id], references: [id], onDelete: Cascade)

  @@index([conversation_id, timestamp])
}

// ───── Operator handoff ────────────────────────────────────

model Operator {
  id              String   @id @default(uuid())
  business_id     String
  email           String
  name            String
  password_hash   String                          // for operator dashboard login
  created_at      DateTime @default(now())

  business        BusinessProfile @relation(fields: [business_id], references: [id], onDelete: Cascade)
  claimedItems    HumanQueueItem[]

  @@unique([business_id, email])
}

model HumanQueueItem {
  id                     String    @id @default(uuid())
  business_id            String
  conversation_id        String
  escalation_reason      String
  triage_snapshot        Json
  status                 String    @default("pending")   // "pending" | "claimed" | "resolved"
  claimed_by             String?
  claimed_at             DateTime?
  resolved_at            DateTime?
  created_at             DateTime  @default(now())

  business               BusinessProfile @relation(fields: [business_id], references: [id], onDelete: Cascade)
  claimer                Operator? @relation(fields: [claimed_by], references: [id])

  @@index([business_id, status, created_at])
}

// ───── Observability ───────────────────────────────────────

model TurnLog {
  id                       String   @id @default(uuid())
  business_id              String
  conversation_id          String
  channel                  String
  ts                       DateTime @default(now())
  duration_ms              Int
  triage                   Json
  attempts                 Json
  outcome                  String                       // "sent" | "human_handoff" | "outside_hours"
  shipped                  String
  intent_path              String?
  language                 String?
  retry_count              Int      @default(0)
  high_severity_violations Int      @default(0)
  tokens_in                Int?
  tokens_out               Int?

  @@index([business_id, ts])
  @@index([intent_path])
  @@index([business_id, conversation_id, ts])
}
```

### Example row — `BusinessProfile`

```json
{
  "id": "8e7b...uuid",
  "name": "Fresh & More",
  "description": "We sell organic groceries in Kathmandu with same-day delivery.",
  "language": "en",
  "tone": {
    "style": "friendly",
    "persona_name": "Sita",
    "do": ["Always greet with Namaste", "End with a friendly close"],
    "dont": ["Never discuss competitor stores", "Never promise prices not in FAQ"]
  },
  "hours": {
    "timezone": "Asia/Kathmandu",
    "schedule": [
      { "day": "Monday", "open": "09:00", "close": "20:00" },
      { "day": "Tuesday", "open": "09:00", "close": "20:00" }
    ],
    "holiday_message": "Namaste! We're closed right now. We'll reply at 9 AM tomorrow."
  },
  "faqs": [
    { "question": "Do you deliver to Bhaktapur?", "answer": "Yes, same-day for orders before 2 PM." },
    { "question": "What's your return policy?", "answer": "Returns accepted within 24 hours of delivery." }
  ],
  "policies": {
    "return_policy": "24-hour return window for perishables.",
    "delivery_info": "Same-day in Kathmandu valley, next-day elsewhere.",
    "payment_methods": ["eSewa", "Khalti", "COD"],
    "custom": []
  },
  "escalation": {
    "triggers": ["refund", "speak to human", "complaint", "manager"],
    "handoff_message": "Let me connect you to a teammate. One moment please."
  },
  "channels": ["whatsapp", "instagram"]
}
```

---

## 4. Complete API surface

Every endpoint your backend exposes. Organised by which actor calls it.

### 4.1 Tenant onboarding APIs

**Base:** `/api/tenants`
**Auth:** `Authorization: Bearer <tenant-api-key>` (or admin key for create)

| Method | Path | Body / params | Returns |
|--------|------|---------------|---------|
| `POST` | `/api/tenants` | full BusinessProfile JSON | `{ id, apiKey }` (apiKey shown once) |
| `GET` | `/api/tenants/me` | — | current BusinessProfile |
| `PATCH` | `/api/tenants/me` | partial BusinessProfile | updated profile (also invalidates Redis cache) |
| `POST` | `/api/tenants/me/api-keys` | `{ label }` | `{ id, key }` (key shown once) |
| `DELETE` | `/api/tenants/me/api-keys/:id` | — | `204` |
| `POST` | `/api/tenants/me/channels/whatsapp` | `{ access_token, phone_number_id, app_secret, verify_token }` | `{ id, webhook_url }` |
| `POST` | `/api/tenants/me/channels/instagram` | `{ access_token, ig_user_id, app_secret, verify_token }` | same |
| `GET` | `/api/tenants/me/conversations` | `?channel&contact_id&limit&cursor` | paginated list of Conversation |
| `GET` | `/api/tenants/me/metrics` | `?from&to` | aggregated metrics (see §4.4) |

### 4.2 Channel webhook APIs (public — Meta calls these)

**Base:** `/api/webhooks`
**Auth:** Meta signs the payload — verify `x-hub-signature-256` using each tenant's `app_secret`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/webhooks/whatsapp` | One-time verification (echoes `hub.challenge`) |
| `POST` | `/api/webhooks/whatsapp` | Inbound WhatsApp message |
| `GET` | `/api/webhooks/instagram` | One-time verification |
| `POST` | `/api/webhooks/instagram` | Inbound Instagram DM |

**Sample WhatsApp inbound payload** (what Meta sends you):

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "WHATSAPP_BUSINESS_ACCOUNT_ID",
    "changes": [{
      "field": "messages",
      "value": {
        "metadata": { "phone_number_id": "1234567890" },
        "contacts": [{ "wa_id": "9779800000000", "profile": { "name": "Ram" } }],
        "messages": [{
          "from": "9779800000000",
          "id": "wamid.xxx",
          "timestamp": "1731450000",
          "type": "text",
          "text": { "body": "Do you deliver to Bhaktapur?" }
        }]
      }
    }]
  }]
}
```

**Your job in the webhook handler:**

1. Verify signature (HMAC-SHA256 of raw body with tenant's `app_secret`).
2. Look up the tenant by `phone_number_id` (must match `ChannelCredential.phone_number_id`).
3. Normalise to your internal `InboundMessage` shape:
   ```ts
   {
     business_id: "<tenant uuid>",
     contact_id: "9779800000000",
     channel: "whatsapp",
     content: "Do you deliver to Bhaktapur?",
     timestamp: new Date(1731450000 * 1000),
     raw: <full payload>
   }
   ```
4. Hand off to `PipelineService.handle(msg)`.
5. Respond `200 OK` to Meta **within 20 seconds** (process pipeline async if needed).

### 4.3 Operator dashboard APIs

**Base:** `/api/operator`
**Auth:** Operator JWT (issued at login)

| Method | Path | Body / params | Returns |
|--------|------|---------------|---------|
| `POST` | `/api/operator/auth/login` | `{ email, password }` | `{ token, operator }` |
| `GET` | `/api/operator/queue` | `?status=pending` | list of HumanQueueItem |
| `POST` | `/api/operator/queue/:id/claim` | — | claimed item |
| `GET` | `/api/operator/conversations/:id` | — | full conversation thread |
| `POST` | `/api/operator/conversations/:id/reply` | `{ content }` | sends via channel adapter, appends to conversation |
| `POST` | `/api/operator/queue/:id/resolve` | `{ resume_ai: boolean }` | marks resolved, optionally unsets `ai_paused` |

### 4.4 Internal services (no HTTP — just NestJS providers)

These are **classes injected into other classes**, not HTTP endpoints. Listed
here so you know the full module surface.

| Service | Public methods |
|---------|----------------|
| `BusinessProfileService` | `get(id)`, `create(profile)`, `update(id, patch)` |
| `SystemPromptCompiler` | `compile(profile) → string` |
| `PromptCacheService` | `get(business_id)`, `set(business_id, prompt)`, `invalidate(business_id)` |
| `ConversationService` | `getOrCreate(business_id, contact_id, channel)`, `getHistory(conv_id, limit)`, `appendTurn(conv_id, role, content, metadata)` |
| `ContextLoaderService` | `load(business_id, contact_id, channel) → ContextPacket` |
| `HoursService` | `isWithinHours(profile) → boolean`, `holidayMessage(profile) → string` |
| `EscalationRulesService` | `check(message, history, profile) → boolean` |
| `ToneCheckerService` | `check(reply, profile) → { pass, reason }` |
| `SafetyFilterService` | `check(reply) → { pass, reason }` |
| `LLMClientService` | `complete(messages, opts) → string` (retries + typed errors) |
| `PromptAssemblerService` | `assemble(ctx, triage, message, failureHint?) → LLMMessage[]` |
| `ResponseCleanerService` | `clean(raw) → string` |
| `PipelineService` | `handle(msg: InboundMessage) → void` ← the conductor |
| `HumanQueueService` | `push(item)`, `claim(id, operator_id)`, `resolve(id, opts)` |
| `ChannelDispatcherService` | `send(business_id, channel, contact_id, content) → void` |
| `WhatsAppAdapter` | `verifyWebhook(req)`, `parseInbound(req) → InboundMessage`, `send(creds, contact, content)` |
| `InstagramAdapter` | same shape as WhatsApp |

### Metrics endpoint response shape (`GET /api/tenants/me/metrics`)

```json
{
  "from": "2026-05-01T00:00:00Z",
  "to": "2026-05-13T23:59:59Z",
  "totals": { "messages_in": 1284, "messages_out": 1199, "handoffs": 47 },
  "rates": { "response_rate": 0.93, "handoff_rate": 0.037, "avg_latency_ms": 3120 },
  "by_intent": { "faq": 612, "sales_inquiry": 401, "complaint": 88, "escalate": 47 },
  "by_hour": [
    { "hour": "09", "count": 87 },
    { "hour": "10", "count": 121 }
  ]
}
```

---

## 5. End-to-end walkthrough of one real message

Concrete example so the abstract pieces click. **A customer named Ram messages
"Fresh & More" on WhatsApp asking about delivery.**

### Step 0 — Setup that already happened

- Fresh & More's owner signed up: `POST /api/tenants` created
  `BusinessProfile { id: "biz-123", name: "Fresh & More", ... }`.
- They added their WhatsApp credentials:
  `POST /api/tenants/me/channels/whatsapp` created
  `ChannelCredential { business_id: "biz-123", channel: "whatsapp",
   phone_number_id: "5555", ... }`.
- They configured the webhook URL `https://chatblix.com/api/webhooks/whatsapp`
  in Meta's Business Manager. Meta did a one-time `GET` verification and
  your backend responded with the `hub.challenge`.

### Step 1 — Ram sends a message on WhatsApp

Ram types "Do you deliver to Bhaktapur?" → Meta wraps it in a webhook payload
and `POST`s to `https://chatblix.com/api/webhooks/whatsapp`.

### Step 2 — Webhook handler (`WhatsAppController`)

```
1. Verify x-hub-signature-256 — reject 401 if signature invalid.
2. Find tenant: SELECT * FROM ChannelCredential WHERE phone_number_id = '5555'
   → business_id = "biz-123".
3. Build InboundMessage:
   { business_id: "biz-123", contact_id: "9779800000000",
     channel: "whatsapp", content: "Do you deliver to Bhaktapur?",
     timestamp: <now>, raw: <payload> }
4. Respond 200 OK to Meta IMMEDIATELY (don't wait for pipeline).
5. Async: PipelineService.handle(msg).
```

### Step 3 — `PipelineService.handle(msg)`

```
3a. ContextLoaderService.load("biz-123", "9779800000000", "whatsapp")
    → fires 3 parallel reads:
       • Redis GET system_prompt:biz-123 → cached compiled prompt
         (if miss: compile fresh, then SET in Redis)
       • Postgres SELECT last 10 ConversationMessage for this conversation
       • Postgres SELECT BusinessProfile WHERE id = "biz-123"
    → returns ContextPacket { systemPrompt, history, profile }

3b. HoursService.isWithinHours(profile) → true (10:30 AM Kathmandu, Monday)
    → continue.   (If false, send profile.hours.holiday_message and STOP.)

3c. TriageService.triage(msg.content, history, profile)
    → LLM call to fast model (Claude Haiku):
       { intent: "faq", sentiment: "neutral", handoff_flag: false,
         is_outside_hours: false }

3d. EscalationRulesService.check(msg.content, history, profile)
    → message doesn't contain "refund", "manager", etc. → false.
    → No handoff. Continue.

3e. PipelineOrchestrator.runWithValidation(ctx, triage, msg.content)
    → loop attempt 1:
       • PromptAssembler builds messages array:
         [system: <compiled prompt>, ...history, user: "[Intent: faq] Do you deliver to Bhaktapur?"]
       • LLMClient.complete(messages) → draft reply
       • ResponseCleaner strips any "Assistant:" prefix
       • Validator.checkGrounding(systemPrompt, draft) → { pass: true }
         (because "Yes, we deliver same-day to Bhaktapur before 2 PM" matches
         an FAQ exactly)
       • ToneChecker.check(draft, profile) → { pass: true }
       • SafetyFilter.check(draft) → { pass: true }  (no PII)
       • All pass → return draft.

3f. ChannelDispatcher.send("biz-123", "whatsapp", "9779800000000", draft)
    → WhatsAppAdapter.send():
       POST https://graph.facebook.com/v21.0/5555/messages
            Authorization: Bearer <decrypted access_token>
            Body: { messaging_product: "whatsapp", to: "9779800000000",
                    type: "text", text: { body: draft } }

3g. ConversationService.appendTurn(conv_id, "user", "Do you deliver...", { ... })
    ConversationService.appendTurn(conv_id, "assistant", draft, { triage, attempts: 1 })

3h. Write a TurnLog row:
    { business_id: "biz-123", conversation_id, channel: "whatsapp",
      duration_ms: 1840, triage: {...}, attempts: [...], outcome: "sent",
      intent_path: "faq", retry_count: 0, tokens_in: 1240, tokens_out: 87 }
```

### Step 4 — Ram receives the reply on WhatsApp

That's the whole round trip. ~2 seconds, 2 LLM calls (triage + generator,
validator passed first try so no retry), 1 outbound HTTP to Meta, 4 Postgres
writes, 1 Redis read.

### Step 5 — What if validator had failed?

`PipelineOrchestrator` would loop again (up to `PIPELINE_MAX_RETRIES`).
If still failing after retries, it throws `EscalationNeededError`, the
pipeline pushes a `HumanQueueItem` to Postgres, publishes
`queue.new:biz-123` on Redis pub/sub, and sends `profile.escalation.handoff_message`
to Ram. An operator dashboard subscribed to that channel sees the new item
in real time.

---

## 6. Implementation order

Build in this order. Each phase is a working slice — don't move to the next
until the current one is end-to-end testable.

### Phase A — Foundation (no LLM changes yet)

A1. **Add Prisma models** for `BusinessProfile`, `TenantApiKey`,
    `ChannelCredential`, `Conversation`, `ConversationMessage`, `Operator`,
    `HumanQueueItem`. Run `pnpm prisma:migrate -- --name multi_tenant_init`.

A2. **Add Redis** to `docker-compose.yml`. Install `ioredis`. Create
    `src/cache/cache.module.ts` exporting a singleton Redis client.
    Add `REDIS_URL` to `EnvSchema`.

A3. **Build `BusinessProfileService`** (CRUD over Prisma) and
    `TenantApiKeyService` (issue + hash-store + verify keys).

A4. **Build tenant API guard**: `TenantAuthGuard` reads
    `Authorization: Bearer <key>`, hashes it, looks up `TenantApiKey`,
    attaches `req.business_id`.

A5. **Build tenant onboarding controller** at `src/tenants/tenants.controller.ts`
    exposing all endpoints in §4.1.

Test: create a tenant, issue an API key, fetch own profile, update tone,
confirm Redis cache invalidates on update.

### Phase B — Compile + cache prompts

B1. **Build `SystemPromptCompiler`** — pure function `compile(profile): string`.
    Snapshot test against the example profile in §3.

B2. **Build `PromptCacheService`** with Redis key `system_prompt:{business_id}`,
    no TTL. Call `invalidate()` from `BusinessProfileService.update()`.

B3. **Build `ConversationService`** (`getOrCreate`, `getHistory`, `appendTurn`).

B4. **Build `ContextLoaderService.load(...)`** — the 3-parallel-Promise.all
    described in T2.1.

Test: write a small script that loads context for the test tenant —
confirm cache hit on second call.

### Phase C — Refactor existing pipeline to use ContextPacket

C1. Change `TriageService.callTriage()` to accept `ContextPacket` instead
    of `kbFile` + ad-hoc args. Replace KB-file logic with
    `profile.faqs` / `profile.policies` access.

C2. Same refactor for `GeneratorService` and `ValidatorService`.

C3. **Extract `PromptAssemblerService`** out of `GeneratorService`. Move
    the message-array building there.

C4. **Build `ResponseCleanerService`** (~20-line utility).

C5. **Build `ToneCheckerService`**, `SafetyFilterService`, `HoursService`,
    `EscalationRulesService` (all deterministic, no LLM).

C6. **Wrap `OpenRouterClient` in `LLMClientService`** — add
    retry-with-backoff + per-tenant token logging.

C7. Update `PipelineOrchestratorService.runWithValidation()` to call
    tone-check and safety-filter alongside grounding-check.

Test: send a message via the existing `POST /api/chat` with a
`business_id` header — confirm full pipeline runs using the new profile.

### Phase D — WhatsApp channel adapter

D1. **Install** `crypto` (built-in) for HMAC verification.

D2. **Build `WhatsAppAdapter`**:
    - `verifyWebhook(req)` — handles GET challenge
    - `verifySignature(body, signature, app_secret)` — HMAC-SHA256 check
    - `parseInbound(payload)` → `InboundMessage`
    - `send(creds, contact_id, content)` → POST to Graph API

D3. **Build `WhatsAppController`** at `src/channels/whatsapp/whatsapp.controller.ts`
    exposing the two webhook endpoints in §4.2.

D4. **Build `ChannelDispatcherService`** — picks the right adapter by
    `channel`, decrypts credentials, calls `adapter.send()`.

D5. **Build `PipelineService.handle(msg)`** — the top-level coordinator
    from §5 step 3. Replace `chat-stream.service.ts` usage path.

Test: use ngrok to expose your local backend, register webhook with a
sandbox WhatsApp number, send a real message, confirm reply arrives.

### Phase E — Operator queue

E1. Add `HumanQueueService.push/claim/resolve` over Prisma.

E2. Add Redis pub/sub: publish `queue.new:{business_id}` after push.

E3. Add `Operator` table + bcrypt password hashing + login endpoint that
    issues a JWT.

E4. Build `OperatorAuthGuard` (verify JWT, attach `req.operator`).

E5. Build operator controller at `src/operator/operator.controller.ts`
    exposing all endpoints in §4.3.

E6. Wire `PipelineService` to call `HumanQueueService.push()` on handoff.

Test: trigger handoff (send "I want to speak to a human"), confirm queue
item appears, confirm pub/sub fires.

### Phase F — Instagram + remaining channels

F1. Build `InstagramAdapter` (very similar to WhatsApp, different Graph URL).
F2. Build `InstagramController`.
F3. Register the adapter in `ChannelDispatcher`.

### Phase G — Metrics

G1. Update `TurnLog` writes to include `business_id`, `tokens_in`, `tokens_out`.

G2. Build `MetricsService.aggregate(business_id, from, to)` — Postgres
    aggregate query over `TurnLog`.

G3. Expose `GET /api/tenants/me/metrics`.

---

## 7. File-by-file: what each new file does

Target end-state of `src/` after all phases. **Bold** = new file.

```
src/
├── main.ts                                            (existing)
├── app.module.ts                                      (existing, adds new modules)
│
├── config/
│   ├── env.validation.ts                              (existing, add REDIS_URL, JWT_SECRET, ENCRYPTION_KEY)
│   ├── app-config.service.ts                          (existing)
│   └── config.module.ts                               (existing)
│
├── prisma/
│   ├── prisma.service.ts                              (existing)
│   └── prisma.module.ts                               (existing)
│
├── **cache/**
│   ├── **redis.client.ts**                            singleton ioredis instance
│   ├── **prompt-cache.service.ts**                    get/set/invalidate compiled prompts
│   └── **cache.module.ts**
│
├── **tenants/**
│   ├── **business-profile.service.ts**                CRUD over BusinessProfile
│   ├── **tenant-api-key.service.ts**                  issue + verify API keys
│   ├── **tenant-auth.guard.ts**                       reads Bearer key, attaches business_id
│   ├── **tenants.controller.ts**                      §4.1 endpoints
│   ├── **system-prompt-compiler.service.ts**          BusinessProfile → string
│   └── **tenants.module.ts**
│
├── **conversation/**
│   ├── **conversation.service.ts**                    getOrCreate, getHistory, appendTurn
│   ├── **context-loader.service.ts**                  produces ContextPacket
│   └── **conversation.module.ts**
│
├── pipeline/
│   ├── triage.service.ts                              (refactor — accept ContextPacket)
│   ├── generator.service.ts                           (refactor)
│   ├── validator.service.ts                           (refactor)
│   ├── orchestrator.service.ts                        (extend with tone+safety checks)
│   ├── **prompt-assembler.service.ts**                builds LLM messages array
│   ├── **response-cleaner.service.ts**                strips role prefixes
│   ├── **llm-client.service.ts**                      wraps OpenRouterClient + retries
│   ├── **tone-checker.service.ts**                    rule-based
│   ├── **safety-filter.service.ts**                   regex PII checks
│   ├── **hours.service.ts**                           timezone-aware open/closed check
│   ├── **escalation-rules.service.ts**                rule-based handoff
│   ├── **pipeline.service.ts**                        top-level handle(InboundMessage)
│   ├── metrics.service.ts                             (extend with per-tenant aggregation)
│   ├── openrouter.client.ts                           (kept, used by llm-client)
│   └── pipeline.module.ts                             (existing, add new providers)
│
├── **channels/**
│   ├── **types.ts**                                   InboundMessage, ChannelAdapter interface
│   ├── **dispatcher.service.ts**                      route send() to right adapter
│   ├── **encryption.service.ts**                      decrypt ChannelCredential.access_token
│   ├── **whatsapp/**
│   │   ├── **whatsapp.adapter.ts**
│   │   ├── **whatsapp.controller.ts**
│   │   └── **whatsapp.module.ts**
│   ├── **instagram/**                                 (phase F)
│   └── **channels.module.ts**
│
├── **operator/**
│   ├── **operator-auth.service.ts**                   bcrypt + JWT
│   ├── **operator-auth.guard.ts**
│   ├── **human-queue.service.ts**                     push/claim/resolve + pub/sub
│   ├── **operator.controller.ts**                     §4.3 endpoints
│   └── **operator.module.ts**
│
├── history/                                           (existing, may be deprecated in favour of conversation/)
│   ├── history.service.ts
│   ├── lead.service.ts
│   └── history.module.ts
│
├── common/                                            (existing, add InboundMessage type)
│   ├── types/
│   └── utils/
│
└── health/                                            (existing)
```

---

## 8. Environment variables — the full list

Add these to `EnvSchema` (`src/config/env.validation.ts`) and `.env`:

| Variable | Required | Example | Purpose |
|----------|----------|---------|---------|
| `PORT` | no | `8000` | HTTP port |
| `DATABASE_URL` | yes | `postgresql://...` | Postgres connection |
| `REDIS_URL` | yes | `redis://localhost:6379` | Cache + pub/sub |
| `OPENROUTER_API_KEY` | yes | `sk-or-...` | LLM provider |
| `PIPELINE_TRIAGE_MODEL` | no | `anthropic/claude-haiku-4.5` | Triage model |
| `PIPELINE_GENERATOR_MODEL` | no | `anthropic/claude-sonnet-4.6` | Generator model |
| `PIPELINE_VALIDATOR_MODEL` | no | `anthropic/claude-haiku-4.5` | Validator model |
| `PIPELINE_*_TIMEOUT_MS` | no | `4500` / `10000` / `4500` | per-stage timeout |
| `PIPELINE_MAX_RETRIES` | no | `1` | validator retry budget |
| `JWT_SECRET` | yes | `<64 random bytes hex>` | sign operator JWTs |
| `JWT_EXPIRES_IN` | no | `12h` | JWT lifetime |
| `ENCRYPTION_KEY` | yes | `<64 random bytes hex>` | AES-256-GCM key for `ChannelCredential.*_encrypted` |
| `ADMIN_API_KEY` | yes | `<random>` | bootstraps the first `POST /api/tenants` |
| `WHATSAPP_GRAPH_API_VERSION` | no | `v21.0` | Meta Graph API version |
| `WHATSAPP_GRAPH_API_BASE` | no | `https://graph.facebook.com` | Meta base URL |

Generate the two secrets once and never rotate without re-encrypting the
`ChannelCredential` table:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
```

---

## 9. Local dev setup

### Add Redis to `docker-compose.yml`

```yaml
services:
  postgres:
    # ... existing config ...

  redis:
    image: redis:7-alpine
    container_name: nest-backend-redis
    ports:
      - '6379:6379'
    volumes:
      - nest_redis_data:/data
    restart: unless-stopped

volumes:
  nest_postgres_data:
  nest_redis_data:
```

### Add to `.env`

```bash
REDIS_URL=redis://localhost:6379
JWT_SECRET=<paste-generated-secret>
ENCRYPTION_KEY=<paste-generated-key>
ADMIN_API_KEY=<paste-random>
WHATSAPP_GRAPH_API_VERSION=v21.0
WHATSAPP_GRAPH_API_BASE=https://graph.facebook.com
```

### Bring up everything

```bash
docker compose up -d                # postgres + redis
pnpm install
pnpm prisma:migrate                 # apply new migrations
pnpm start:dev                      # nest watch mode
```

### Expose webhook to Meta during dev (with ngrok)

```bash
ngrok http 8000
# → use the https URL as your webhook URL in Meta Business Manager
```

---

## 10. Sample requests you can run today

These are the requests you'd make against the finished system. Use them as
acceptance tests as you build.

### Create a tenant (bootstrap with admin key)

```bash
curl -X POST https://chatblix.com/api/tenants \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Fresh & More",
    "description": "Organic groceries in Kathmandu.",
    "language": "en",
    "tone": {
      "style": "friendly",
      "persona_name": "Sita",
      "do": ["Greet with Namaste"],
      "dont": ["Discuss competitors"]
    },
    "hours": {
      "timezone": "Asia/Kathmandu",
      "schedule": [{ "day": "Monday", "open": "09:00", "close": "20:00" }],
      "holiday_message": "We are closed. Back at 9 AM."
    },
    "faqs": [
      { "question": "Do you deliver to Bhaktapur?", "answer": "Yes, same-day for orders before 2 PM." }
    ],
    "policies": {
      "return_policy": "24-hour return window.",
      "delivery_info": "Same-day in valley.",
      "payment_methods": ["eSewa", "COD"],
      "custom": []
    },
    "escalation": {
      "triggers": ["refund", "manager"],
      "handoff_message": "Connecting you to a teammate."
    },
    "channels": ["whatsapp"]
  }'
```

→ returns `{ "id": "biz-123", "apiKey": "tk_live_..." }` (save the apiKey).

### Update tone (invalidates Redis prompt cache automatically)

```bash
curl -X PATCH https://chatblix.com/api/tenants/me \
  -H "Authorization: Bearer tk_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "tone": { "style": "formal", "persona_name": "Sita", "do": [], "dont": [] } }'
```

### Attach WhatsApp credentials

```bash
curl -X POST https://chatblix.com/api/tenants/me/channels/whatsapp \
  -H "Authorization: Bearer tk_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "access_token": "EAA...META_TOKEN",
    "phone_number_id": "5555",
    "app_secret": "abcdef...",
    "verify_token": "my-chosen-verify-secret"
  }'
```

→ returns `{ "id": "...", "webhook_url": "https://chatblix.com/api/webhooks/whatsapp" }`.

### Operator login

```bash
curl -X POST https://chatblix.com/api/operator/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "email": "ram@freshandmore.com", "password": "..." }'
```

→ returns `{ "token": "eyJhb...", "operator": { ... } }`.

### Operator claims a queue item

```bash
curl -X POST https://chatblix.com/api/operator/queue/queue-456/claim \
  -H "Authorization: Bearer eyJhb..."
```

### Fetch metrics

```bash
curl "https://chatblix.com/api/tenants/me/metrics?from=2026-05-01&to=2026-05-13" \
  -H "Authorization: Bearer tk_live_..."
```

---

## Where to start tomorrow

The single smallest concrete first step:

1. Open `prisma/schema.prisma`.
2. Add the `BusinessProfile` model from §3 (copy-paste).
3. Run `pnpm prisma migrate dev --name add_business_profile`.
4. Open Prisma Studio (`pnpm prisma:studio`), insert one test row by hand.
5. Move on to phase A2 (Redis).

Everything else cascades from those four lines of work.
