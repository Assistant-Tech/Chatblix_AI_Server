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
| 1 | [AI_BACKEND_ARCHITECTURE.md](./AI_BACKEND_ARCHITECTURE.md) | You want to understand the service end-to-end. Start here. |
| 2 | [KB_MANAGEMENT.md](./KB_MANAGEMENT.md) | You're working on profile sync, the system-prompt compiler, or the prompt cache. |
| 3 | [CONVERSATION_HISTORY.md](./CONVERSATION_HISTORY.md) | You're confused how recent conversation turns reach the LLM (spoiler: in the request body, not from a database). |
| 4 | [COST_AND_BILLING.md](./COST_AND_BILLING.md) | You're planning capacity, setting SaaS prices, or tracking token spend. |

These three are the **authoritative** design for this service. If anything
else contradicts them, these win.

---

## Archived

The four docs under [`archive/`](./archive/) describe an earlier scope
where this service owned channels, operators, and tenant auth — all of
which actually belong to the **main backend**. See
[`archive/README.md`](./archive/README.md) for what each archived doc
covers and which team should reference it.

Do not use anything in `archive/` as a build guide for this service.

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
├── auth/         InternalTokenGuard           NEW
├── business/     BusinessProfile + compiler   NEW
├── cache/        Redis client + prompt cache  NEW
├── reply/        POST /ai/v1/reply            NEW
├── pipeline/     triage/generator/validator   refactored
├── prisma/       PrismaService                kept
├── config/       env validation               kept
└── health/       GET /ai/v1/health            kept
```

Detail of each module is in `AI_BACKEND_ARCHITECTURE.md §8`.

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
| What endpoints this service exposes | `AI_BACKEND_ARCHITECTURE.md §4` |
| The request/response JSON shapes | `AI_BACKEND_ARCHITECTURE.md §5` |
| A traced walkthrough of one real customer message | `AI_BACKEND_ARCHITECTURE.md §6` |
| The full data model (only 2 tables) | `AI_BACKEND_ARCHITECTURE.md §7` |
| Implementation order | `AI_BACKEND_ARCHITECTURE.md §14` |
| How tenant KB flows from edit → LLM context | `KB_MANAGEMENT.md §3` |
| How recent conversation history reaches the LLM | `CONVERSATION_HISTORY.md §1` |
| The exact LLM API call shape (system + history + new message) | `CONVERSATION_HISTORY.md §5` |
| The `BusinessProfile` shape (every field annotated) | `KB_MANAGEMENT.md §4` |
| Migration from current `kb/*.json` files | `KB_MANAGEMENT.md §11` |
| Per-message LLM cost (with and without caching) | `COST_AND_BILLING.md §4` |
| Per-conversation cost & token usage (1–50 turns) | `COST_AND_BILLING.md §4.7` |
| Per-business monthly cost projections | `COST_AND_BILLING.md §5` |
| SaaS pricing tiers + margin analysis | `COST_AND_BILLING.md §11` |
| Cost optimization levers (in priority order) | `COST_AND_BILLING.md §12` |
| Token-cost formulas you can plug into code | `COST_AND_BILLING.md §15` |
