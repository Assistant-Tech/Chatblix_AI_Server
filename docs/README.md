# Chatblix AI Backend — Documentation

This service is a focused AI microservice. It accepts customer messages from
the main backend, runs them through a Triage → Generator → Validator LLM
pipeline, and returns either a reply or an escalation signal.

It does **not** handle channels, conversations, operators, or tenant auth —
those belong to the main backend.

---

## Current design (read these — in order)

| # | Doc | Read it when... |
|---|---|---|
| 0 | [Architecture.md](./Architecture.md) | You want to understand this service's reply pipeline end-to-end. **Start here.** |
| 1 | [AI_EVOLUTION_ROADMAP.md](./AI_EVOLUTION_ROADMAP.md) | You want where this is headed: prompted pipeline → agentic → RAG. |
| 2 | [TENANT_ANALYTICS_AGENT.md](./TENANT_ANALYTICS_AGENT.md) | You're working on the tenant analytics agent. |

The **cross-repo authoritative design** lives in main-backend's docs — if anything
here contradicts them, those win:

- [`main-backend/docs/AI_SYSTEM.md`](../../main-backend/docs/AI_SYSTEM.md) — canonical design & implementation reference (profile sync, prompt compile, integration contract)
- [`main-backend/docs/REDIS_AND_SCALING.md`](../../main-backend/docs/REDIS_AND_SCALING.md) — Redis topology (single shared Redis: main writes `profile:{id}`, ai-backend reads it)
- [`main-backend/docs/BUSINESS_PROFILE_API.md`](../../main-backend/docs/BUSINESS_PROFILE_API.md) — the `BusinessProfile` shape, every field

---

## 30-second version

```
[ Customer ]
     │
     │ WhatsApp / Instagram / web
     ▼
[ Main Backend ]                ←──  channels, tenants, conversations,
     │                                operators, dashboard — all here
     │ POST /ai/v1/reply
     ▼
[ AI Backend (this repo) ]      ←──  prompt compiler, LLM pipeline,
     │                                turn log — only this
     ▼
[ OpenRouter / Postgres / Redis ]
```

Five endpoints. Two database tables. One shared secret with the main backend.
That's the whole service.

---

## What lives here (target file layout)

```
src/
├── auth/         InternalTokenGuard
├── business/     BusinessProfile + compiler
├── cache/        Redis client + prompt cache
├── reply/        POST /ai/v1/reply
├── pipeline/     triage/generator/validator
├── prisma/       PrismaService
├── config/       env validation
└── health/       GET /ai/v1/health
```

Detail of the pipeline stages is in [`Architecture.md`](./Architecture.md).

---

## What does **not** live here

If you find yourself adding any of these to this repo, stop and reconsider —
they belong to the main backend.

- Channel adapters (WhatsApp, Instagram, etc.)
- Webhook signature verification from Meta
- Conversation history storage (long-term)
- Operator dashboard, queue, JWT auth
- Tenant signup, billing, plan limits
- The customer-facing knowledge editor UI

---

## Quick links into the current docs

| You want to know... | Go to |
|---|---|
| This service's reply pipeline, end-to-end | [`Architecture.md`](./Architecture.md) |
| The queue job + HTTP fallback contract with main-backend | [`../../main-backend/docs/AI_SYSTEM.md`](../../main-backend/docs/AI_SYSTEM.md) |
| The `BusinessProfile` shape (every field) | [`../../main-backend/docs/BUSINESS_PROFILE_API.md`](../../main-backend/docs/BUSINESS_PROFILE_API.md) |
| Redis topology (who writes/reads `profile:{id}` / `prompt:{id}`) | [`../../main-backend/docs/REDIS_AND_SCALING.md`](../../main-backend/docs/REDIS_AND_SCALING.md) |
| Where the architecture is headed (agentic, RAG) | [`AI_EVOLUTION_ROADMAP.md`](./AI_EVOLUTION_ROADMAP.md) |
| The tenant analytics agent | [`TENANT_ANALYTICS_AGENT.md`](./TENANT_ANALYTICS_AGENT.md) |
