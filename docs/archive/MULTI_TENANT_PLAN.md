# Multi-Tenant Agent Platform — Build Plan

This document captures the phased plan for evolving the current single-tenant
chat pipeline into a multi-tenant, multi-channel agent platform, and assesses
how well it fits the existing codebase.

---

## TL;DR — Does it fit the current system?

**Yes — fit is good.** Roughly **40% of the foundation already exists** in the
current code; the remaining 60% is additive (multi-tenancy, Redis cache,
channel adapters, operator queue). No structural rewrite is required.

The current stack (**NestJS 11 + TypeScript 6 + Prisma 7 + Postgres + OpenRouter**)
is exactly the substrate the plan assumes. The 3-stage pipeline (Triage →
Generator → Validator with retry) is already implemented under `src/pipeline/`
and only needs to be re-keyed by `business_id` instead of the hardcoded
single-tenant context.

The only new infrastructure dependency is **Redis** (for the compiled-prompt
cache and operator queue pub/sub) — everything else slots into the existing
NestJS module structure.

---

## Gap analysis — plan vs. current code

| Task | Status | Notes |
| --- | --- | --- |
| **T1.1** Business profile schema | NEW | Add `BusinessProfile` Prisma model. Current schema only has `Lead`, `Message`, `TurnLog` |
| **T1.2** System prompt compiler | PARTIAL | `src/pipeline/prompts.service.ts` compiles from KB files — refactor to take a `BusinessProfile` instead |
| **T1.3** Conversation store | EXISTS | `Message` model + `src/history/history.service.ts`. Add `business_id` + `channel` columns |
| **T1.4** Compiled-prompt cache (Redis) | NEW | No Redis in project yet. Add `RedisModule` + cache service |
| **T2.1** Tenant context loader | NEW | Replaces the ad-hoc context fetch in `chat.controller.ts` / `chat-stream.service.ts` |
| **T3.1** Triage service | EXISTS | `src/pipeline/triage.service.ts`. Currently takes static KB context — swap for `BusinessProfile` |
| **T3.2** Rule-based escalation | NEW | No deterministic escalation layer today |
| **T3.3** Outside-hours check | NEW | No hours/timezone awareness today |
| **T4.1** Prompt assembler | PARTIAL | `src/pipeline/generator.service.ts` assembles prompts internally. Extract into a `PromptAssembler` that consumes `ContextPacket` |
| **T4.2** LLM client wrapper | EXISTS | `src/pipeline/openrouter.client.ts` already has typed errors (`OpenRouterError`) and timeouts. Add retry-with-backoff and per-tenant token logging |
| **T4.3** Response cleaner | NEW | Likely small util — add under `src/common/utils/` |
| **T5.1** Grounding check | EXISTS | `src/pipeline/validator.service.ts` already does an LLM-based verdict |
| **T5.2** Tone check (rules) | NEW | Currently bundled inside validator LLM call — pull out into a deterministic checker |
| **T5.3** Safety filter (regex/PII) | NEW | No PII regex today |
| **T5.4** Retry orchestrator | EXISTS | `src/pipeline/orchestrator.service.ts` already implements the retry loop with `PIPELINE_MAX_RETRIES` |
| **T6.1** Channel adapters | NEW | Only HTTP entry today (`chat.controller.ts`). WhatsApp/IG/etc are net-new modules |
| **T6.2** Pipeline entry point | PARTIAL | `chat.controller.ts` is the current entry. Refactor body into a channel-agnostic `PipelineService.handle(InboundMessage)` |
| **T7.1** Human queue | NEW | No operator handoff today |
| **T7.2** Operator API | NEW | No operator endpoints today |
| **T8.1** Pipeline trace log | EXISTS | `TurnLog` model + `src/pipeline/metrics.service.ts` already capture this — extend with `business_id` + `channel` |
| **T8.2** Tenant metrics API | NEW | `/api/health/pipeline` exists but is global. Add per-tenant aggregation endpoint |

**Legend:** EXISTS = ready to reuse · PARTIAL = exists but needs refactor · NEW = build from scratch

---

## What already works in your favour

- The 3-stage **Triage → Generator → Validator with retry** pipeline is the
  exact shape the plan assumes — no rearchitecture, just re-parameterise it
  per-tenant.
- `OpenRouterClient` already exposes a typed-error surface
  (`OpenRouterError` with `kind: 'timeout' | 'api_error' | 'no_content' | 'config'`)
  and per-call timeouts — T4.2 just needs retry-with-backoff + tenant tagging.
- `TurnLog` already captures most of T8.1 (input, triage, attempts, outcome,
  intent_path, language, retry_count, severity counts). Adding `business_id`
  + `channel` indexed columns finishes it.
- Prisma 7 + the `pg` adapter handle Postgres cleanly; no DB-layer surprises
  for adding `BusinessProfile` and `HumanQueueItem` tables.
- The NestJS module layout (`pipeline/`, `chat/`, `history/`, `prisma/`,
  `health/`, `config/`) is already a good shape for adding `business/`,
  `channels/`, `operator/`, `cache/` siblings.

## Risks / things to plan for

- **Redis is a new infra dependency.** Add it to `docker-compose.yml`
  alongside Postgres, expose `REDIS_URL` in `.env`, gate cache reads behind a
  feature flag so local dev can run without Redis if needed.
- **Multi-tenancy is invasive.** Every existing service that touches
  `session_id` needs to also carry `business_id`. Add `business_id` to:
  `Lead`, `Message`, `TurnLog`, and every service signature. Plan one
  migration that backfills a default `business_id` for legacy rows.
- **The current KB system (`src/pipeline/kb/` + `corpus.service.ts`) is
  effectively the v0 of a business profile.** Decide whether to keep the
  file-based KB as a fallback or fully replace it with the DB-backed profile.
- **Outside-hours short-circuit must run before any LLM call** to be a real
  cost win — wire it as the first check in `PipelineService.handle()`.

---

## Phase 1 — Foundation

### Task 1.1 — Business profile schema

Design the structured form that every tenant fills when onboarding. This
becomes the brain of their agent. Store it in Postgres:

```typescript
{
  business_id: uuid
  name: string
  description: string          // "We sell handmade shoes in Kathmandu"
  language: string             // "en" | "ne" | "hi"
  tone: {
    style: "formal" | "friendly" | "casual"
    persona_name: string       // "Sita" — the agent's name
    do: string[]               // ["Always greet by name", "Use 'Namaste' to close"]
    dont: string[]             // ["Never discuss competitors", "Never quote prices not listed"]
  }
  hours: {
    timezone: string
    schedule: { day: string, open: string, close: string }[]
    holiday_message: string
  }
  faqs: { question: string, answer: string }[]   // up to 50 Q&A pairs
  policies: {
    return_policy: string
    delivery_info: string
    payment_methods: string[]
    custom: { label: string, content: string }[]
  }
  escalation: {
    triggers: string[]         // ["refund", "legal", "speak to human"]
    handoff_message: string    // what agent says before handing off
  }
  channels: string[]           // ["whatsapp", "instagram"]
}
```

### Task 1.2 — System prompt compiler

Write a `SystemPromptCompiler` service that takes a `business_profile` and
returns a fully rendered string. This is the core of the no-RAG approach —
everything the agent knows lives here.

```typescript
// services/system-prompt-compiler.service.ts
compile(profile: BusinessProfile): string {
  return `
You are ${profile.tone.persona_name}, the AI assistant for ${profile.name}.
${profile.description}

TONE & STYLE
Style: ${profile.tone.style}
Always: ${profile.tone.do.join(', ')}
Never: ${profile.tone.dont.join(', ')}

BUSINESS HOURS (${profile.hours.timezone})
${profile.hours.schedule.map(s => `${s.day}: ${s.open}–${s.close}`).join('\n')}
If customer contacts outside hours: "${profile.hours.holiday_message}"

POLICIES
Returns: ${profile.policies.return_policy}
Delivery: ${profile.policies.delivery_info}
Payment: ${profile.policies.payment_methods.join(', ')}
${profile.policies.custom.map(p => `${p.label}: ${p.content}`).join('\n')}

FREQUENTLY ASKED QUESTIONS
${profile.faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}

RULES
- Only answer from the information above. If you don't know, say so honestly.
- Never invent prices, policies, or facts not listed here.
- If customer says any of these words, escalate immediately: ${profile.escalation.triggers.join(', ')}
  `.trim()
}
```

### Task 1.3 — Conversation store

Table in Postgres keyed by `(business_id, contact_id, channel)`:

```typescript
// Each row is one message turn
{
  id: uuid
  business_id: uuid
  contact_id: string       // phone number, IG handle, email, etc.
  channel: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: Date
  metadata: jsonb          // triage result, validator flags, etc.
}
```

Fetch last 10 turns before every pipeline run. Add a `ConversationService`
with `getHistory(business_id, contact_id, channel, limit)` and
`appendTurn(...)`.

### Task 1.4 — Compiled prompt cache

The system prompt for a tenant won't change between messages. Cache the
compiled string in Redis keyed by `business_id`. Invalidate on profile
update. This avoids recompiling on every request.

```typescript
// Redis key: system_prompt:{business_id}
// TTL: none — invalidate explicitly on profile save
```

---

## Phase 2 — Tenant context loader

### Task 2.1 — Context loader service

Single service, called at the start of every pipeline run. Returns
everything the pipeline needs:

```typescript
// context-loader.service.ts
async load(business_id: string, contact_id: string, channel: string): Promise<ContextPacket> {
  const [systemPrompt, history, profile] = await Promise.all([
    this.promptCache.get(business_id) ?? this.compileAndCache(business_id),
    this.conversationService.getHistory(business_id, contact_id, channel, 10),
    this.businessProfileService.get(business_id),
  ])

  return { systemPrompt, history, profile, contact_id, channel }
}
```

`ContextPacket` is the single object that flows through all three pipeline
stages.

---

## Phase 3 — Triage stage

### Task 3.1 — Triage service

One focused LLM call. Small, fast model. Takes the incoming message + last
3 turns of history. Returns structured JSON only — no reply generation here.

```typescript
// triage.service.ts
async triage(message: string, history: Turn[], profile: BusinessProfile): Promise<TriageResult> {
  const prompt = `
Classify this customer message for a business assistant.
Recent conversation: ${JSON.stringify(history.slice(-3))}
Incoming message: "${message}"
Escalation triggers: ${profile.escalation.triggers.join(', ')}

Respond ONLY with valid JSON:
{
  "intent": "faq | complaint | sales_inquiry | greeting | out_of_scope | escalate",
  "sentiment": "positive | neutral | negative | angry",
  "handoff_flag": boolean,
  "handoff_reason": string | null,
  "is_outside_hours": boolean
}
  `
  const raw = await this.llm.complete(prompt, { model: 'fast' })
  return JSON.parse(raw)
}
```

### Task 3.2 — Rule-based escalation layer

Don't rely solely on the LLM for handoff decisions. Layer deterministic
rules on top:

```typescript
// escalation-rules.service.ts
check(message: string, history: Turn[], profile: BusinessProfile): boolean {
  const lower = message.toLowerCase()

  // Keyword match against tenant's escalation triggers
  if (profile.escalation.triggers.some(t => lower.includes(t))) return true

  // 3 consecutive negative turns
  const last3 = history.slice(-3)
  if (last3.length === 3 && last3.every(t => t.metadata?.sentiment === 'negative')) return true

  return false
}
```

If either the LLM triage or the rule check sets `handoff_flag: true`, skip
generator + validator entirely.

### Task 3.3 — Outside-hours check

Before triage even runs, check if the message arrived outside business
hours using the profile's schedule and timezone. If outside hours: return
the `holiday_message` directly, skip the entire pipeline. No LLM call needed.

```typescript
// hours.service.ts
isWithinHours(profile: BusinessProfile): boolean {
  const now = DateTime.now().setZone(profile.hours.timezone)
  const today = profile.hours.schedule.find(s => s.day === now.weekdayLong)
  if (!today) return false
  return now.hour >= parseInt(today.open) && now.hour < parseInt(today.close)
}
```

---

## Phase 4 — Generator stage

### Task 4.1 — Prompt assembler

Takes the `ContextPacket` + `TriageResult` and builds the full messages
array for the LLM:

```typescript
// prompt-assembler.service.ts
assemble(ctx: ContextPacket, triage: TriageResult, userMessage: string): LLMMessage[] {
  return [
    { role: 'system', content: ctx.systemPrompt },
    ...ctx.history.map(t => ({ role: t.role, content: t.content })),
    {
      role: 'user',
      content: `[Intent: ${triage.intent} | Sentiment: ${triage.sentiment}]\n${userMessage}`
    }
  ]
}
```

The triage metadata is appended to the user message as a hint — the
generator uses it to calibrate its response (e.g. more empathetic tone on
angry sentiment).

### Task 4.2 — LLM client wrapper

Centralised wrapper around the LLM provider (OpenAI / Anthropic / etc.) with:

```typescript
// llm-client.service.ts
async complete(messages: LLMMessage[], options: LLMOptions): Promise<string> {
  // - retry with exponential backoff (3 attempts)
  // - timeout at 15s
  // - log: business_id, tokens_in, tokens_out, latency_ms, model
  // - throw typed errors: LLMTimeoutError, LLMRateLimitError, LLMContentError
}
```

Log every call. You'll need it for billing per tenant and for debugging bad
replies.

### Task 4.3 — Response cleaner

Strip any artefacts from the raw LLM output before passing to validator:

```typescript
// response-cleaner.service.ts
clean(raw: string): string {
  return raw
    .replace(/^\s*(assistant:|AI:|bot:)/i, '')   // strip role prefixes
    .replace(/\[Intent:.*?\]/g, '')               // strip triage hints if echoed back
    .trim()
}
```

---

## Phase 5 — Validator stage

### Task 5.1 — Grounding check

Since there's no RAG, grounding means: does the reply contradict or go
beyond what's in the system prompt? Run a second LLM call:

```typescript
// validator.service.ts
async checkGrounding(systemPrompt: string, reply: string): Promise<{ pass: boolean, issues: string[] }> {
  const prompt = `
System prompt (the only source of truth):
${systemPrompt}

Agent reply to validate:
"${reply}"

Does the reply contain any facts, prices, policies, or claims NOT found in the system prompt?
Respond ONLY with JSON: { "pass": boolean, "issues": string[] }
  `
  return JSON.parse(await this.llm.complete(prompt, { model: 'fast' }))
}
```

### Task 5.2 — Tone check

Rule-based, no LLM call needed:

```typescript
// tone-checker.service.ts
check(reply: string, profile: BusinessProfile): { pass: boolean, reason: string | null } {
  const lower = reply.toLowerCase()

  for (const banned of profile.tone.dont) {
    if (lower.includes(banned.toLowerCase()))
      return { pass: false, reason: `Reply contains banned phrase: "${banned}"` }
  }

  // Check persona name is used correctly if required
  // Check sign-off is present if required by tone rules

  return { pass: true, reason: null }
}
```

### Task 5.3 — Safety filter

Hard regex checks, synchronous, no LLM:

```typescript
// safety-filter.service.ts
check(reply: string): { pass: boolean, reason: string | null } {
  const PII_PATTERNS = [/\b\d{10,}\b/, /[\w.]+@[\w.]+\.\w+/]  // phone, email
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(reply))
      return { pass: false, reason: 'PII detected in reply' }
  }
  return { pass: true, reason: null }
}
```

### Task 5.4 — Retry orchestrator

Wires all three checks and manages the generator retry loop:

```typescript
// pipeline-orchestrator.service.ts
async runWithValidation(ctx, triage, userMessage): Promise<string> {
  let attempt = 0
  let failureHint = ''

  while (attempt < 2) {
    const messages = this.promptAssembler.assemble(ctx, triage, userMessage, failureHint)
    const draft = this.responseCleaner.clean(await this.llm.complete(messages))

    const grounding = await this.validator.checkGrounding(ctx.systemPrompt, draft)
    const tone = this.toneChecker.check(draft, ctx.profile)
    const safety = this.safetyFilter.check(draft)

    if (grounding.pass && tone.pass && safety.pass) return draft

    // Compose failure hint for next attempt
    failureHint = [
      !grounding.pass ? `Grounding issues: ${grounding.issues.join(', ')}` : '',
      !tone.pass ? `Tone issue: ${tone.reason}` : '',
      !safety.pass ? `Safety issue: ${safety.reason}` : '',
    ].filter(Boolean).join('\n')

    attempt++
  }

  throw new EscalationNeededError('Validator exhausted retries')
}
```

---

## Phase 6 — Channel adapters + dispatcher

### Task 6.1 — Channel adapters (one per platform)

Each adapter is a NestJS module with two responsibilities: receive webhook
→ normalise to `InboundMessage`, and send reply → format for that platform's
API.

```typescript
// Internal format every adapter must produce
interface InboundMessage {
  business_id: string
  contact_id: string
  channel: 'whatsapp' | 'instagram' | 'facebook' | 'email'
  content: string
  timestamp: Date
  raw: any   // original webhook payload, stored for debugging
}
```

Build adapters in this order: WhatsApp first (highest volume), then
Instagram, then others.

### Task 6.2 — Pipeline entry point

One `PipelineService` that all channel adapters call:

```typescript
// pipeline.service.ts
async handle(msg: InboundMessage): Promise<void> {
  const ctx = await this.contextLoader.load(msg.business_id, msg.contact_id, msg.channel)

  // Outside hours → short-circuit
  if (!this.hoursService.isWithinHours(ctx.profile)) {
    await this.dispatcher.send(msg, ctx.profile.hours.holiday_message)
    return
  }

  const triage = await this.triageService.triage(msg.content, ctx.history, ctx.profile)

  // Handoff → short-circuit
  if (triage.handoff_flag || this.escalationRules.check(msg.content, ctx.history, ctx.profile)) {
    await this.humanQueue.push(msg, ctx, triage)
    await this.dispatcher.send(msg, ctx.profile.escalation.handoff_message)
    return
  }

  let reply: string
  try {
    reply = await this.orchestrator.runWithValidation(ctx, triage, msg.content)
  } catch (e) {
    if (e instanceof EscalationNeededError) {
      await this.humanQueue.push(msg, ctx, triage)
      await this.dispatcher.send(msg, ctx.profile.escalation.handoff_message)
      return
    }
    throw e
  }

  await this.dispatcher.send(msg, reply)
  await this.conversationService.appendTurn(msg, reply, triage)
}
```

---

## Phase 7 — Operator queue

### Task 7.1 — Human queue service

Postgres table + Redis pub/sub to notify the operator dashboard in real time:

```typescript
// human_queue table
{
  id: uuid
  business_id: uuid
  contact_id: string
  channel: string
  conversation_snapshot: jsonb   // full history at time of escalation
  triage_result: jsonb
  escalation_reason: string
  status: 'pending' | 'claimed' | 'resolved'
  claimed_by: string | null
  created_at: Date
}
```

### Task 7.2 — Operator API endpoints

```
GET    /operator/queue              → list pending items for business_id
POST   /operator/queue/:id/claim    → lock item to operator
POST   /operator/queue/:id/reply    → send reply, log to conversation history
POST   /operator/queue/:id/resolve  → mark done, optionally resume AI handling
```

---

## Phase 8 — Observability

### Task 8.1 — Pipeline trace log

One record per inbound message:

```typescript
{
  message_id, business_id, contact_id, channel,
  triage_intent, triage_sentiment, handoff_flag,
  generator_attempts,      // 1 or 2
  validator_pass,          // true | false
  final_disposition,       // 'sent' | 'human_handoff' | 'outside_hours'
  latency_ms,
  tokens_in, tokens_out,
  created_at
}
```

### Task 8.2 — Tenant metrics API

Aggregate from trace logs, exposed to each tenant's dashboard:
response rate, handoff rate, avg latency, top intents, busiest hours.

---

## Build order

1. **T1.1** Business profile schema
2. **T1.2** System prompt compiler
3. **T1.3** Conversation store
4. **T1.4** Compiled prompt cache (Redis)
5. **T2.1** Context loader service
6. **T3.3** Outside-hours check          ← first short-circuit, easiest win
7. **T3.1** Triage service
8. **T3.2** Escalation rules
9. **T4.1** Prompt assembler
10. **T4.2** LLM client wrapper
11. **T4.3** Response cleaner
12. **T5.2** Tone check (rule-based)
13. **T5.3** Safety filter (regex)
14. **T5.1** Grounding check (LLM)
15. **T5.4** Retry orchestrator
16. **T6.1** First channel adapter (WhatsApp)
17. **T6.2** Pipeline entry point
18. **T7.1** Human queue
19. **T7.2** Operator API
20. **T8.1** Trace logging
21. **T8.2** Metrics API

Get **T1 → T6.2** working end-to-end with one hardcoded tenant and WhatsApp
only. Then add multi-tenancy, then remaining channels, then operator layer,
then metrics.

---

## Suggested NestJS module layout (target end state)

```
src/
├── app.module.ts
├── main.ts
├── config/                  # existing — AppConfigService
├── prisma/                  # existing — PrismaService with pg adapter
├── cache/                   # NEW — RedisModule + PromptCacheService
├── business/                # NEW — BusinessProfileService + SystemPromptCompiler
├── conversation/            # REFACTOR of src/history/ — keyed by (business_id, contact_id, channel)
├── context/                 # NEW — ContextLoaderService → ContextPacket
├── pipeline/                # EXISTING — refactor stages to accept ContextPacket
│   ├── triage.service.ts
│   ├── generator.service.ts
│   ├── validator.service.ts
│   ├── orchestrator.service.ts
│   ├── prompt-assembler.service.ts        # NEW
│   ├── response-cleaner.service.ts        # NEW
│   ├── llm-client.service.ts              # rename of openrouter.client.ts
│   ├── tone-checker.service.ts            # NEW
│   ├── safety-filter.service.ts           # NEW
│   ├── escalation-rules.service.ts        # NEW
│   └── hours.service.ts                   # NEW
├── channels/                # NEW
│   ├── whatsapp/
│   ├── instagram/
│   └── dispatcher.service.ts
├── operator/                # NEW — human queue + operator API
├── metrics/                 # extract from src/pipeline/metrics.service.ts
└── health/                  # existing
```

---

## First-week concrete checklist

If starting Monday, this is the minimum slice that proves the architecture
works for a single hardcoded tenant on a single channel:

1. Add `BusinessProfile` Prisma model + migration
2. Add `business_id` columns to `Message` + `TurnLog` (backfill with a
   single default tenant for existing rows)
3. Add Redis to `docker-compose.yml`, wire `REDIS_URL` into `.env`
4. Write `SystemPromptCompiler` + `PromptCacheService`
5. Write `ContextLoaderService`
6. Refactor `TriageService` / `GeneratorService` / `ValidatorService` to
   accept `ContextPacket` instead of pulling KB themselves
7. Add `HoursService` short-circuit at top of pipeline
8. Stand up one hardcoded WhatsApp adapter (or stub it with an HTTP
   webhook mock) and route through `PipelineService.handle()`
9. Confirm a real message flows end-to-end and lands in `Message` /
   `TurnLog` keyed by the new `business_id`

Everything from Phase 7 onward (operator queue, multi-channel, full
metrics) builds on that foundation without touching it.
