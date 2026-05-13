# Knowledge Base Management

> How a tenant's business knowledge flows from their dashboard edit, through
> the main backend, into this AI service, and finally into every LLM call.

This doc answers three questions:

1. **Where does the KB live?**
2. **Who is allowed to edit it, and how?**
3. **How does the pipeline see it on every reply, in milliseconds?**

If you've already read `AI_BACKEND_ARCHITECTURE.md`, this is the deep dive on
the one piece of data that flows between the two services.

---

## 0. TL;DR

- **KB = `BusinessProfile`.** There is no separate "knowledge base" entity.
  The same `BusinessProfile` that holds tone and hours also holds FAQs,
  policies, product catalog, and any other business knowledge.
- **Source of truth: the main backend.** Tenants edit there. Versioning,
  audit log, and the dashboard editor live there.
- **AI backend has a synced cache** — same data, replicated via
  `PUT /ai/v1/businesses/{id}` whenever the tenant saves changes.
- **The pipeline reads KB through a compiled system prompt** cached in
  Redis. Cache key: `prompt:{business_id}`. Hot path is **one Redis GET**.
- **No retrieval, no embeddings, no RAG.** The whole KB sits in the LLM
  context window on every call. Anthropic prompt caching makes the cost
  acceptable. We add retrieval only when a tenant's KB outgrows the prompt
  budget (see §10).

---

## 1. What "KB" actually means

The word "knowledge base" is ambiguous. In this system it concretely means
**everything the agent must know to answer correctly**:

| Field group | Examples | Used by |
|---|---|---|
| Identity | business name, description, persona name | system prompt header |
| Tone | style, do's, don'ts | system prompt + tone-checker |
| Hours | timezone, weekly schedule, holiday message | hours short-circuit |
| FAQs | up to ~100 Q&A pairs | system prompt body |
| Policies | return, delivery, payment, custom | system prompt body |
| **Catalog** | products, SKUs, prices, availability | system prompt body |
| Escalation | trigger keywords, handoff message | rule-based escalation |
| Custom | anything else (locations, loyalty program, size charts, ...) | system prompt body |

**Everything in the table above is part of one `BusinessProfile` row.**

---

## 2. Where each piece of KB lives

There are three places the KB exists at any moment. Knowing which is which
prevents the most common multi-service bug: stale data on the wrong side.

```
┌─────────────────────────┐    PUT       ┌─────────────────────────┐
│  MAIN BACKEND           │  ─────────►  │  AI BACKEND             │
│                         │              │                         │
│  Postgres               │              │  Postgres               │
│   business              │              │   business_profile      │
│   business_kb_versions  │              │     (mirror)            │
│  ───────────────────    │              │  ───────────────────    │
│  Source of truth.       │              │  Synced replica.        │
│  Editor UI, audit log,  │              │  Lives only to feed     │
│  version history,       │              │  the compiler.          │
│  rollback.              │              │                         │
└─────────────────────────┘              └────────┬────────────────┘
                                                  │  compile + cache
                                                  ▼
                                         ┌─────────────────────────┐
                                         │  Redis                  │
                                         │   prompt:{business_id}  │
                                         │  ───────────────────    │
                                         │  Compiled system prompt │
                                         │  string. Hot path.      │
                                         │  Invalidated on PUT.    │
                                         └─────────────────────────┘
```

| Layer | What it stores | Mutated by | TTL |
|---|---|---|---|
| Main backend Postgres | Authoritative KB + every revision | Tenant via dashboard UI | None |
| AI backend Postgres | Latest synced copy of the profile | `PUT /ai/v1/businesses/{id}` from main backend | None — replaced on each PUT |
| AI backend Redis | Compiled system prompt string | Compiler on cache miss | None — explicit `DEL` on PUT |

**Rule:** AI backend never edits KB. It only reads what main backend pushes.

---

## 3. The end-to-end flow — tenant edit to live agent

```
1. Tenant logs into main backend dashboard, edits FAQ #4
        │
        ▼
2. Main backend: SAVE
   • UPDATE business SET kb_json = $newKb WHERE id = $bizId
   • INSERT INTO business_kb_versions (snapshot, edited_by, note)
   • Returns 200 to dashboard
        │
        ▼
3. Main backend: SYNC
   • PUT https://ai.internal/ai/v1/businesses/$bizId
     Authorization: Bearer $INTERNAL_API_TOKEN
     Body: <full BusinessProfile>
        │
        ▼
4. AI backend
   a) Validate body shape (class-validator on DTO)
   b) UPSERT business_profile WHERE id = $bizId
   c) DEL prompt:$bizId in Redis (invalidate compiled prompt cache)
   d) DEL profile:$bizId in Redis (invalidate raw profile cache, optional)
   e) Respond 200 { id, version, updated_at }
        │
        ▼
5. Customer messages the business on WhatsApp
   • Main backend receives webhook, calls POST /ai/v1/reply with $bizId
        │
        ▼
6. AI backend reply path
   a) Redis GET prompt:$bizId → MISS (we just invalidated)
   b) SELECT business_profile WHERE id = $bizId
   c) SystemPromptCompiler.compile(profile) → string
   d) Redis SET prompt:$bizId = compiled string
   e) Run Triage → Generator → Validator with the compiled prompt
   f) Return reply to main backend
        │
        ▼
7. From this point on, every reply for that business is a Redis HIT
   until the next PUT invalidates it.
```

**Latency math for step 6 on a cold cache (worst case):**
- Postgres SELECT: ~3 ms
- Compile (string concat): ~0.5 ms
- Redis SET: ~1 ms

So a cache miss adds ~5 ms to the first request after every edit. Every
request after that pays only the Redis GET (~1 ms).

---

## 4. The `BusinessProfile` shape — what fields, what they're for

Final shape that AI backend stores. Same as in `AI_BACKEND_ARCHITECTURE.md §7`
but annotated by purpose.

```jsonc
{
  "id": "biz-123",
  "name": "Fresh & More",
  "description": "Organic Himalayan skincare brand.",
  "language": "en",

  // ── Behavioral knobs ────────────────────────────────────
  "tone": {
    "style": "friendly",
    "persona_name": "Sita",
    "do":   ["Greet with Namaste"],
    "dont": ["Discuss competitors"]
  },

  // ── Operational knobs (consumed by deterministic services) ─
  "hours": {
    "timezone": "Asia/Kathmandu",
    "schedule": [{ "day": "Monday", "open": "09:00", "close": "20:00" }],
    "holiday_message": "We're closed. Back at 9 AM."
  },
  "escalation": {
    "triggers": ["refund", "manager", "speak to human"],
    "handoff_message": "Let me connect you to a teammate."
  },

  // ── Knowledge content (compiled into system prompt) ─────
  "kb": {
    "faqs": [
      { "question": "...", "answer": "..." }
    ],
    "policies": {
      "return_policy":   "24-hour window for perishables.",
      "delivery_info":   "Same-day in Kathmandu valley.",
      "payment_methods": ["eSewa", "Khalti", "COD"],
      "custom": [
        { "label": "Loyalty program", "content": "..." }
      ]
    },
    "catalog": [
      {
        "sku": "FM-SCRUB-ORANGE",
        "name": "Orange Face Scrub",
        "price_npr": 950,
        "stock_status": "in_stock",
        "key_ingredients": ["Orange peel", "Cane sugar"],
        "skin_type": ["normal", "combination"]
      }
    ],
    "extras": {                                     // free-form, optional
      "locations": ["...", "..."],
      "size_chart_url": "https://..."
    }
  }
}
```

**Key decisions:**

- `tone`, `hours`, `escalation` are **first-class fields** because specific
  services consume them programmatically (the tone checker reads `tone.dont`,
  hours service reads `hours.schedule`, etc.).
- Everything else — facts, products, policies — is bundled under `kb`. The
  compiler dumps `kb` into the system prompt body. Adding a new category
  doesn't require schema changes or compiler edits; just put it under
  `kb.extras` or extend `kb.policies.custom`.
- `catalog` is its own field under `kb` so it can be edited independently
  in the dashboard without rewriting the whole profile, and so the
  compiler can render it in a stable section.

---

## 5. How the pipeline reads KB on every reply

This is the question you asked: **"how would the pipeline know the KB of a
business before replying?"** Here is the exact mechanism.

```ts
// src/reply/reply.service.ts (simplified)

async handle(req: ReplyRequest): Promise<ReplyResponse> {
  // [1] Identify the tenant — business_id is in the request body
  const businessId = req.business_id;

  // [2] Load the compiled system prompt (one Redis GET on warm cache)
  const ctx = await this.contextLoader.load(businessId, req.history);
  // ctx = {
  //   systemPrompt: <compiled string with FAQs, policies, catalog, etc.>,
  //   profile:      <raw BusinessProfile, for deterministic services>,
  //   history:      <req.history, trimmed to MAX_HISTORY_TURNS>,
  // }

  // [3] Hours short-circuit (reads profile.hours, no LLM)
  if (!this.hours.isWithinHours(ctx.profile)) {
    return { status: "outside_hours", reply: ctx.profile.hours.holiday_message, ... };
  }

  // [4] Triage — LLM call. The compiled system prompt is NOT sent here;
  //     triage uses a smaller classification prompt. But it does see the
  //     escalation.triggers and tone from the profile.
  const triage = await this.triage.classify(req.message, ctx);

  // [5] Escalation rule check (reads profile.escalation.triggers + history)
  if (triage.handoff_flag || this.escalation.check(req.message, req.history, ctx.profile)) {
    return { status: "escalate", reason: "...", suggested_handoff_message: ... };
  }

  // [6] Generator + Validator loop
  //     THE COMPILED SYSTEM PROMPT IS SENT HERE as the LLM's `system` message.
  //     This is the moment the LLM "sees" the entire KB.
  const reply = await this.orchestrator.runWithValidation(ctx, triage, req.message);

  // [7] Log + return
  await this.metrics.recordTurn(...);
  return { status: "replied", reply, metadata: { ... } };
}
```

**The "pipeline knows the KB" via step 6: the system message it sends to the
generator is the compiled prompt, which already contains every FAQ, every
catalog item, and every policy.**

There is no retrieval step. The LLM has the entire KB in its context.

### Inside `ContextLoaderService.load()`

```ts
// src/reply/context-loader.service.ts (simplified)

async load(businessId: string, history: HistoryMessage[]): Promise<ContextPacket> {
  // [a] Try the hot cache first
  let systemPrompt = await this.promptCache.get(businessId);
  let profile: BusinessProfile;

  if (systemPrompt) {
    // [b] Warm path — also fetch raw profile (smaller TTL cache)
    profile = await this.profileCache.get(businessId)
           ?? await this.businessService.getOrThrow(businessId);
    await this.profileCache.set(businessId, profile);
  } else {
    // [c] Cold path — fetch profile, compile, cache both
    profile = await this.businessService.getOrThrow(businessId);
    systemPrompt = this.compiler.compile(profile);
    await this.promptCache.set(businessId, systemPrompt);
    await this.profileCache.set(businessId, profile);
  }

  return {
    business_id: businessId,
    profile,
    systemPrompt,
    history: history.slice(-this.config.maxHistoryTurns()),
    contact_id: '', channel: '', trace_id: undefined,  // filled by ReplyService
  };
}
```

### Inside `SystemPromptCompiler.compile()`

Pure function. Takes a `BusinessProfile`, returns a string. Tested with
snapshots.

```ts
// src/business/system-prompt-compiler.service.ts (simplified)

compile(p: BusinessProfile): string {
  return [
    `You are ${p.tone.persona_name}, the AI assistant for ${p.name}.`,
    p.description,
    '',
    'TONE & STYLE',
    `Style: ${p.tone.style}`,
    `Always: ${p.tone.do.join(', ')}`,
    `Never: ${p.tone.dont.join(', ')}`,
    '',
    'BUSINESS HOURS (' + p.hours.timezone + ')',
    p.hours.schedule.map(s => `${s.day}: ${s.open}–${s.close}`).join('\n'),
    '',
    'POLICIES',
    `Returns: ${p.kb.policies.return_policy}`,
    `Delivery: ${p.kb.policies.delivery_info}`,
    `Payment: ${p.kb.policies.payment_methods.join(', ')}`,
    ...p.kb.policies.custom.map(c => `${c.label}: ${c.content}`),
    '',
    'PRODUCT CATALOG',
    ...p.kb.catalog.map(item => renderCatalogItem(item)),
    '',
    'FREQUENTLY ASKED QUESTIONS',
    ...p.kb.faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`),
    '',
    'RULES',
    '- Only answer from the information above. If you don\'t know, say so honestly.',
    '- Never invent prices, policies, or facts not listed.',
    `- If customer says any of these words, escalate immediately: ${p.escalation.triggers.join(', ')}`,
  ].join('\n').trim();
}
```

That's it. KB is just a string we send to the LLM.

---

## 6. Editing flow (tenant POV)

This is what tenants will see. None of this happens in this repo — it's
main backend's job — but you should understand it so the API contracts
make sense.

```
1. Tenant opens dashboard → "My agent" → "Knowledge"
2. They see five tabs: Identity, Tone, Hours, Catalog, FAQs & Policies
3. They edit a catalog item's price
4. They click "Save"
        │
        ▼
5. Dashboard calls main backend's PATCH /tenants/me/business/kb
   { kb: { catalog: [...] } }
        │
        ▼
6. Main backend
   a) Loads current business row
   b) Merges the patch into kb_json
   c) Writes a new business_kb_versions row (audit trail)
   d) UPDATEs the business row
   e) PUTs the full new profile to AI backend
        │
        ▼
7. AI backend invalidates Redis caches and stores the new profile
        │
        ▼
8. Next customer message for this business uses the new prices.
```

**Latency from "click Save" to "agent uses new KB":** typically < 100 ms.

---

## 7. KB sync API contract (what main backend calls)

Recap of the endpoints defined in `AI_BACKEND_ARCHITECTURE.md §4`:

### `PUT /ai/v1/businesses/{business_id}`

- **Body:** the **full** `BusinessProfile` JSON. Always full replace.
- **Why full replace, not diff:** simpler to reason about, idempotent,
  no merge conflicts, no "what if the diff format changes."
- **Idempotency:** sending the same body twice is a no-op (well, it bumps
  `version` and invalidates cache twice — both harmless).
- **Response:**
  ```json
  { "id": "biz-123", "version": 17, "updated_at": "2026-05-13T11:22:00Z" }
  ```

### `DELETE /ai/v1/businesses/{business_id}`

- **Soft delete:** sets `active = false`. Subsequent `/reply` calls for
  this business return `404`.
- **Why soft, not hard:** `TurnLog` rows reference `business_id`; keeping
  the profile row preserves referential integrity for analytics.

### `GET /ai/v1/businesses/{business_id}` (optional, debug-only)

- Returns the current profile + `last_compiled_at` timestamp.
- Useful for AI engineers verifying a sync went through.
- Not used in the hot path.

---

## 8. Versioning & rollback

### Where revisions are stored

**In main backend.** Every save creates a `business_kb_versions` row with:
- `version` integer (monotonic per business)
- `kb_json` snapshot
- `edited_by` (admin email or "system")
- `created_at`
- optional `note`

### How AI backend participates

Just stores the current `version` integer on its `business_profile` row,
bumped on every PUT. This version number is recorded in every `TurnLog` so
you can correlate "which reply used which KB version."

### Rollback flow

1. Tenant clicks "Restore version 14" in main backend's dashboard.
2. Main backend reads `business_kb_versions[version=14].kb_json`.
3. Main backend writes a NEW version (e.g. `version=18`) with that same
   `kb_json` (do not move the version counter backward — always forward).
4. Main backend PUTs the restored profile to AI backend.
5. AI backend's cache invalidates. Next reply uses the rolled-back KB.

Forward-only versioning keeps the audit log honest. No "version 14 used by
2026-05-13 conversations means current KB, except for the 2-hour window we
rolled back, except no actually we rolled forward to 18 which is a copy of
14." Just: every change is a new version. Always increasing.

---

## 9. Token budget — does the whole KB fit?

Yes, by a wide margin, for almost all tenants.

| Item | Typical tokens |
|---|---|
| Identity (name, description, persona) | 80 |
| Tone (style, do/don't) | 100 |
| Hours (timezone, schedule, holiday) | 80 |
| FAQs × 50 (Q + A, ~40 tokens each) | 2 000 |
| Policies + custom | 400 |
| Catalog × 50 items, ~50 tokens each | 2 500 |
| Escalation | 30 |
| Compiler scaffolding (headers, rules) | 200 |
| **Total** | **~5 400 tokens** |

Claude Sonnet 4.6 context window: **200 000 tokens**. Headroom is ~97%.

For very catalog-heavy tenants (500+ products), the compiled prompt might
reach 25 000–40 000 tokens. Still inside the window. The cost increase
matters more than the latency — see §10 for mitigation.

### Anthropic prompt caching makes this cheap

The compiled system prompt is **identical across every reply for a given
business** until the next PUT. Anthropic's prompt caching gives ~90% cost
reduction on the cached portion after the first hit. Concretely:

- Without caching: ~6K tokens × $3/Mtok × 1000 calls = **$18/day** per
  business.
- With caching: first hit pays full; subsequent hits pay ~10%. Effective
  cost ≈ **$2/day** per business.

The savings show up automatically — you just send the same system prompt
each time and Anthropic does the rest. No client-side changes needed.

---

## 10. When KB outgrows the prompt (v2 path)

For a tenant with 5 000 products and 500 FAQs, the compiled prompt would
hit 100K+ tokens. At that scale:
- Cost per call gets noticeable even with prompt caching.
- Latency from the model processing the prompt rises.
- Some non-Anthropic providers have smaller context windows.

**v2 plan (don't build this yet):**

1. **Split KB into "core" and "retrievable"**:
   - core: identity, tone, hours, policies, top 20 FAQs, rules — always in
     the system prompt (~3K tokens).
   - retrievable: full catalog, long-tail FAQs — stored in a separate table
     with embedding vectors.
2. **Add a retrieval step before the generator**: embed the user message,
   look up top-5 relevant catalog items + FAQs (Postgres pgvector or a
   dedicated vector DB), inject only those into the generator's user-message
   preamble.
3. **Validator unchanged**: still validates against `core + retrieved`
   chunks as the grounding source.

When v2 is needed:
- A tenant breaks 50K tokens of compiled prompt.
- p95 reply latency rises above 4 s for that tenant alone.
- Cost per tenant exceeds business margin.

Until any of those triggers fire, the no-RAG path is the right choice.

---

## 11. Migration from the existing KB JSON files

Today the repo has `src/pipeline/kb/fresh-and-more.json` and
`clothing-store.json`. Migration steps:

1. **Pick a UUID** for each KB file → that's its `business_id`.
2. **Write a one-shot script** (`scripts/migrate-kb.ts`):
   ```ts
   for (const file of ['fresh-and-more.json', 'clothing-store.json']) {
     const raw = JSON.parse(readFileSync(`src/pipeline/kb/${file}`, 'utf8'));
     const profile = mapLegacyKbToProfile(raw); // see mapping below
     await prisma.businessProfile.upsert({
       where: { id: profile.id },
       create: profile,
       update: profile,
     });
   }
   ```
3. **Field mapping** (legacy → BusinessProfile):
   | Legacy key | New location |
   |---|---|
   | `business_name` | `name` |
   | `industry` | `description` |
   | `channels` | dropped (main backend owns channels) |
   | `product_catalog` | `kb.catalog` |
   | `current_offers` | `kb.extras.offers` |
   | `delivery_policy` | `kb.policies.delivery_info` |
   | `return_and_exchange_policy` | `kb.policies.return_policy` |
   | `payment_methods` | `kb.policies.payment_methods` |
   | `cod_policy` | `kb.policies.custom[]` |
   | `loyalty_program` | `kb.extras.loyalty_program` |
   | `size_chart_url` | `kb.extras.size_chart_url` |
   | `size_guidance` | `kb.extras.size_guidance` |
   | `emi_options` | `kb.policies.custom[]` |
   | `brand_voice` | `tone.do` / `tone.dont` (split manually) |
   | `high_value_threshold_npr` | `kb.extras.high_value_threshold_npr` |
   | `locations` | `kb.extras.locations` |
   | `hours` | `hours.schedule` (reformat) |
   | `timezone` | `hours.timezone` |
4. **Delete `src/pipeline/kb/` and `corpus.service.ts`** once the migration
   has run and the new pipeline is producing the same outputs.

---

## 12. Testing the KB layer

Two kinds of tests pay back many times their cost:

### 12.1 Compiler snapshot tests

```ts
// system-prompt-compiler.spec.ts
it('renders a stable system prompt for the Fresh & More fixture', () => {
  const profile = loadFixture('fresh-and-more.json');
  const compiled = compiler.compile(profile);
  expect(compiled).toMatchSnapshot();
});
```

Any unintended change to the compiled prompt becomes a visible diff in
review. Critical because the prompt directly governs LLM behavior.

### 12.2 Grounding contract tests

```ts
// validator.spec.ts (integration)
it('flags replies that invent a price not in the catalog', async () => {
  const profile = mockProfileWithCatalog([{ sku: 'X', price_npr: 950 }]);
  const fakeReply = "Yes, that costs NPR 1200";
  const verdict = await validator.checkGrounding(compile(profile), fakeReply);
  expect(verdict.pass).toBe(false);
});
```

These tests are the contract between the KB and the agent's behavior. If
they pass, you can refactor the compiler and pipeline freely.

---

## 13. What this means for day-to-day work

When a tenant complains "the agent gave the wrong answer," debugging
follows a fixed path:

1. **Pull the `TurnLog`** for the offending conversation → note
   `business_id`, `kb_version`, the full `attempts` blob.
2. **Fetch the profile at that version** from main backend's
   `business_kb_versions` table.
3. **Recompile locally** with `SystemPromptCompiler` to get the exact
   system prompt that was used.
4. **Check three things in order:**
   a. Was the fact in the KB at all? → KB content issue → tenant edit.
   b. Was it in the KB but the LLM ignored it? → compiler ordering or
      prompt-engineering issue → fix in this repo.
   c. Was the validator supposed to catch a hallucination but didn't? →
      validator tuning issue → fix in this repo.

The fact that **every reply is reproducible from a `(business_id,
kb_version, message)` triple** is the whole reason for the versioning design.

---

## 14. Where to start

If you're implementing this layer right now, build in this order:

1. **`BusinessProfile` Prisma model** with the shape from §4.
2. **`SystemPromptCompiler.compile()`** as a pure function — start by
   producing the same output the current `PromptsService` does for the
   Fresh & More KB. Lock it with a snapshot test.
3. **`BusinessProfileService.upsert()`** that writes to Postgres AND
   invalidates both Redis keys.
4. **`PUT /ai/v1/businesses/{id}` controller** wired to the upsert.
5. **`ContextLoaderService.load()`** with the cache-aside pattern from §5.
6. **Replace the KB-file path** in `triage/generator/validator` services
   with `ctx.systemPrompt` / `ctx.profile`.

Step 1 → 6 is the minimum slice that proves multi-tenant KB works
end-to-end with one hardcoded business.
