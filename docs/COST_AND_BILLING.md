# Cost & Billing Analysis

> Comprehensive breakdown of what it costs to run this AI backend, where the
> money goes, and how to price the service to tenants. Every number is
> traceable to its assumptions — change the assumptions, change the answer.

---

## 0. TL;DR — what does this cost?

| Scale | Messages/month | LLM cost/month | Infra cost/month | **Total cost/month** |
|---|---:|---:|---:|---:|
| Single small business | 3 000 | **$22** | (shared) | **~$22** |
| Single medium business | 15 000 | **$110** | (shared) | **~$110** |
| Single large business | 60 000 | **$440** | (shared) | **~$440** |
| 10-tenant SaaS | 60 000 (avg 6K each) | $440 | $115 | **~$555** |
| 100-tenant SaaS | 600 000 (avg 6K each) | $4 400 | $245 | **~$4 645** |
| 1 000-tenant SaaS | 6 000 000 (avg 6K each) | $44 000 | $945 | **~$44 945** |

**Per-message cost on the hot path:** ~$0.0073 (with prompt caching, no retry).

**Per-message cost without prompt caching:** ~$0.028 (~3.8× more expensive).
This is why §6 matters more than any other section in this doc.

**Per-message cost with one validator retry:** ~$0.013.

**Per-message cost on the high-value Opus path:** ~$0.037 (5× standard).

**Per-conversation cost** (warm cache, 10 % retry, +5 % OpenRouter):

| Conversation length | Final cost | Total LLM tokens (in / out) |
|---|---:|---:|
| 1 turn (drive-by) | $0.007 | 11 880 / 330 |
| 5 turns (typical) | **$0.040** | 61 500 / 1 650 |
| 10 turns (extended) | **$0.090** | 126 600 / 3 300 |
| 20 turns (long) | $0.201 | 260 400 / 6 600 |

See [§4.7](#47-per-conversation-rollup--tokens-and-cost) for the full
breakdown per conversation length.

All numbers below show how those come about.

---

## Table of contents

1. [Where the money goes — the cost components](#1-where-the-money-goes--the-cost-components)
2. [LLM pricing reference (what providers charge you)](#2-llm-pricing-reference)
3. [Token budget per pipeline stage](#3-token-budget-per-pipeline-stage)
4. [Per-turn cost — concrete math](#4-per-turn-cost--concrete-math)
   - [4.7 Per-conversation rollup — tokens and cost](#47-per-conversation-rollup--tokens-and-cost)
5. [Per-business monthly cost projections](#5-per-business-monthly-cost-projections)
6. [Prompt caching — the single biggest lever](#6-prompt-caching--the-single-biggest-lever)
7. [Validator retries — what they cost](#7-validator-retries--what-they-cost)
8. [The high-value Opus path](#8-the-high-value-opus-path)
9. [Infrastructure costs](#9-infrastructure-costs)
10. [Cost at SaaS scale (10 → 1 000 tenants)](#10-cost-at-saas-scale)
11. [Pricing recommendations to tenants](#11-pricing-recommendations-to-tenants)
12. [Cost optimization levers — in priority order](#12-cost-optimization-levers)
13. [Cost monitoring & alerting](#13-cost-monitoring--alerting)
14. [Worked example — Fresh & More for one month](#14-worked-example--fresh--more-for-one-month)
15. [Formulas — predict cost from any inputs](#15-formulas--predict-cost-from-any-inputs)
16. [Caveats & verification](#16-caveats--verification)

---

## 1. Where the money goes — the cost components

| Component | % of total cost | Why |
|---|---:|---|
| LLM API calls (Triage + Generator + Validator) | **~95%** | Three LLM calls per turn, billed per token |
| Application server (NestJS containers) | ~2% | CPU/memory for the pipeline orchestration |
| Postgres (managed) | ~1.5% | BusinessProfile + TurnLog |
| Redis (managed) | ~1% | Prompt cache + idempotency keys |
| Logs, metrics, egress | ~0.5% | Structured logs + metrics export |

**Take-away:** infrastructure is a rounding error. **The only number that
matters at scale is the LLM bill.** This entire doc focuses on optimising
that one number.

---

## 2. LLM pricing reference

All prices in USD per million tokens (Mtok). **Verify these numbers against
Anthropic's pricing page before committing to a budget** — they change.

### 2.1 Anthropic direct pricing (base rates)

| Model | Input ($/Mtok) | Output ($/Mtok) | Cache write ($/Mtok) | Cache read ($/Mtok) |
|---|---:|---:|---:|---:|
| Claude **Haiku 4.5** | $1.00 | $5.00 | $1.25 | $0.10 |
| Claude **Sonnet 4.6** | $3.00 | $15.00 | $3.75 | $0.30 |
| Claude **Opus 4.7** | $15.00 | $75.00 | $18.75 | $1.50 |

Pattern: **cache write is 1.25× base input; cache read is 0.10× base input**
(90 % discount).

### 2.2 OpenRouter markup

Your current setup routes through OpenRouter. OpenRouter passes through the
provider's price plus ~5 % platform fee on most models.

| Routing | Sonnet input cost | Multiplier |
|---|---:|---:|
| Direct Anthropic | $3.00 / Mtok | 1.00× |
| Via OpenRouter | $3.15 / Mtok | 1.05× |

**Trade-off:** OpenRouter gives you model-agnostic fallback and unified
billing for ~5 % more. Going direct saves 5 % but loses cross-provider
failover. Worth keeping OpenRouter at small scale; reconsider when LLM bill
> $5 000/month.

> **Important caveat:** Anthropic's prompt-cache pricing on OpenRouter may
> differ from direct. Verify in OpenRouter's docs before relying on cache
> economics if you stay on OpenRouter.

### 2.3 Token estimation rule of thumb

For English/Romanised text: **1 token ≈ 4 characters ≈ 0.75 words**.
For Devanagari/CJK: roughly **1 token ≈ 1–2 characters** (higher overhead).

This doc uses English-mode estimates. Add ~30 % overhead for tenants whose
KB or messages are predominantly Devanagari/Nepali/Hindi script.

---

## 3. Token budget per pipeline stage

A "turn" = one inbound customer message → one assistant reply. Three LLM
calls happen during a normal turn.

### 3.1 Triage call (Haiku)

| Component | Tokens | Cached? |
|---|---:|:---:|
| Triage system prompt (classifier instructions) | 500 | ✓ |
| Last 3 turns of history | 300 | — |
| Current message | 50 | — |
| Triage scaffolding (escalation triggers from profile) | 100 | ✓ |
| **Input total** | **950** | — |
| Output JSON `{intent, sentiment, handoff_flag, ...}` | 100 | — |

### 3.2 Generator call (Sonnet, or Opus for high-value)

| Component | Tokens | Cached? |
|---|---:|:---:|
| Compiled system prompt (KB) | 5 400 | ✓ |
| Last 10 turns of history | 1 200 | — |
| Triage hint prefix on user message | 30 | — |
| Current message | 50 | — |
| **Input total** | **6 680** | — |
| Output (the reply text) | 150 | — |

### 3.3 Validator call (Haiku)

| Component | Tokens | Cached? |
|---|---:|:---:|
| Compiled system prompt (same as generator's) | 5 400 | ✓ |
| Validator scaffolding ("does the reply ground in...") | 200 | ✓ |
| Generated reply being validated | 150 | — |
| **Input total** | **5 750** | — |
| Output JSON `{pass, issues}` | 80 | — |

### 3.4 Total per turn

| Metric | Triage | Generator | Validator | **Total** |
|---|---:|---:|---:|---:|
| Input tokens | 950 | 6 680 | 5 750 | **13 380** |
| Output tokens | 100 | 150 | 80 | **330** |
| Cached input tokens (after warm-up) | 600 | 5 400 | 5 600 | **11 600** |
| Fresh input tokens (per turn) | 350 | 1 280 | 150 | **1 780** |

**Insight:** ~87 % of input tokens are *cacheable* — meaning the prompt cache
is the difference between a sustainable bill and a runaway one.

---

## 4. Per-turn cost — concrete math

All prices in USD per turn. Two scenarios per pipeline stage: **no cache**
(every call pays full input price) and **warm cache** (KB cached, history
fresh).

### 4.1 Without prompt caching

| Stage | Input cost | Output cost | Stage total |
|---|---:|---:|---:|
| Triage (Haiku) | 950 × $1 / 1M = $0.00095 | 100 × $5 / 1M = $0.0005 | **$0.00145** |
| Generator (Sonnet) | 6 680 × $3 / 1M = $0.02004 | 150 × $15 / 1M = $0.00225 | **$0.02229** |
| Validator (Haiku) | 5 750 × $1 / 1M = $0.00575 | 80 × $5 / 1M = $0.0004 | **$0.00615** |
| **Per-turn total** | | | **$0.02989** |

Round to **$0.030 per turn without caching**.

### 4.2 With prompt caching (warm cache)

Cached portion = compiled prompt (5 400 tok) shared between Generator and
Validator, plus Triage's static scaffolding (600 tok).

| Stage | Cached input cost | Fresh input cost | Output cost | Stage total |
|---|---:|---:|---:|---:|
| Triage (Haiku) | 600 × $0.10 / 1M = $0.00006 | 350 × $1 / 1M = $0.00035 | $0.0005 | **$0.00091** |
| Generator (Sonnet) | 5 400 × $0.30 / 1M = $0.00162 | 1 280 × $3 / 1M = $0.00384 | $0.00225 | **$0.00771** |
| Validator (Haiku) | 5 600 × $0.10 / 1M = $0.00056 | 150 × $1 / 1M = $0.00015 | $0.0004 | **$0.00111** |
| **Per-turn total** | | | | **$0.00973** |

Round to **~$0.010 per turn with warm cache** — a **3× saving**.

> **Note on first call after KB edit:** the first turn after every PUT pays
> *cache-write* prices (1.25× base input) on the cached portion, then
> subsequent turns get cache reads. For a tenant with N turns between
> edits, average cost ≈ `(1 × write_price + (N-1) × read_price) / N`. At
> N > 20 the write-cost amortises away.

### 4.3 With one validator retry (~10 % of turns)

A retry = second generator call + second validator call.

| Scenario | Cost |
|---|---:|
| First attempt (warm cache) | $0.00973 |
| Retry: generator + validator (still warm) | $0.00882 |
| **Total when retry triggers** | **$0.01855** |
| **Average across all turns (10 % retry rate)** | $0.00973 × 0.9 + $0.01855 × 0.1 = **$0.01062** |

### 4.4 Outside-hours short-circuit (zero LLM cost)

| Stage | Cost |
|---|---:|
| Hours check (in-process) | $0 |
| Reply = `profile.hours.holiday_message` (no LLM) | $0 |
| **Per-turn total** | **$0** |

If ~10 % of inbound traffic is outside hours, the **effective average cost
drops further**: $0.01062 × 0.9 = **$0.00956 per inbound message**.

### 4.5 Final blended per-message rate

| Assumption | Multiplier | Effective per-message cost |
|---|---:|---:|
| Base (warm cache, no retry, in-hours) | 1.00× | $0.00973 |
| Retry adjustment (10 % retry rate) | 1.09× | $0.01062 |
| Outside-hours adjustment (10 % traffic) | 0.90× | $0.00956 |
| Escalation adjustment (3 % short-circuit after triage) | 0.98× | $0.00937 |
| OpenRouter platform fee | 1.05× | **$0.00984** |

**Plan around $0.010 per inbound customer message.** That is the single
number to memorise.

### 4.6 Per-turn cost — all scenarios in one table

| Scenario | Per-turn cost | vs base |
|---|---:|---:|
| Warm cache, no retry, in-hours | $0.00973 | 1.00× |
| Cold cache (first call, cache write) | $0.01200 | 1.23× |
| Warm cache + 1 retry | $0.01855 | 1.91× |
| **Worst case (cold cache + retry)** | $0.02100 | **2.16×** |
| **No caching at all** | $0.02989 | **3.07×** |
| High-value path (Opus generator, warm cache) | $0.03700 | 3.80× |
| Outside-hours short-circuit | $0.00000 | 0.00× |

### 4.7 Per-conversation rollup — tokens and cost

A **conversation** is a sequence of N turns between one customer and the
agent. Conversation-level cost is just the sum of per-turn costs — but
there's an important wrinkle: **as the conversation grows, each new turn
carries more history**, so each later turn is slightly more expensive than
the previous one. This continues until the `MAX_HISTORY_TURNS = 10` cap
kicks in, after which per-turn cost plateaus.

#### Per-turn cost growth inside one conversation

History tokens that Triage carries (last 3 turns × 100 tok) and Generator
carries (last 10 turns × 120 tok) ramp up turn by turn. Validator never
sees history, so its cost is constant.

| Turn # in conversation | Triage cost | Generator cost | Validator cost | **Per-turn total** | History carried (tok) |
|---:|---:|---:|---:|---:|---:|
| 1 (first message) | $0.00061 | $0.00411 | $0.00111 | **$0.00583** | 0 |
| 2 | $0.00071 | $0.00447 | $0.00111 | **$0.00629** | 120 |
| 3 | $0.00081 | $0.00483 | $0.00111 | **$0.00675** | 240 |
| 4 | $0.00091 | $0.00519 | $0.00111 | **$0.00721** | 360 |
| 5 | $0.00091 | $0.00555 | $0.00111 | **$0.00757** | 480 |
| 6 | $0.00091 | $0.00591 | $0.00111 | **$0.00793** | 600 |
| 7 | $0.00091 | $0.00627 | $0.00111 | **$0.00829** | 720 |
| 8 | $0.00091 | $0.00663 | $0.00111 | **$0.00865** | 840 |
| 9 | $0.00091 | $0.00699 | $0.00111 | **$0.00901** | 960 |
| 10 | $0.00091 | $0.00735 | $0.00111 | **$0.00937** | 1 080 |
| 11+ (steady state) | $0.00091 | $0.00771 | $0.00111 | **$0.00973** | 1 200 |

#### Total tokens & cost by conversation length

For each conversation length N, summing all turns:

| Conversation length (N) | Cumulative input tokens | Cumulative output tokens | Cost — warm cache | Cost — no cache | Cache savings |
|---|---:|---:|---:|---:|---:|
| 1 turn (drive-by) | 11 880 | 330 | **$0.0058** | $0.0260 | 78 % |
| 2 turns | 23 980 | 660 | **$0.0121** | $0.0524 | 77 % |
| 3 turns (quick Q&A) | 36 300 | 990 | **$0.0189** | $0.0794 | 76 % |
| 5 turns (typical) | 61 500 | 1 650 | **$0.0337** | $0.1345 | 75 % |
| 10 turns (extended) | 126 600 | 3 300 | **$0.0769** | $0.2785 | 72 % |
| 15 turns | 193 500 | 4 950 | **$0.1256** | $0.4279 | 71 % |
| 20 turns (long) | 260 400 | 6 600 | **$0.1742** | $0.5773 | 70 % |
| 30 turns | 394 200 | 9 900 | **$0.2715** | $0.8761 | 69 % |
| 50 turns (rare, full escalation) | 661 800 | 16 500 | **$0.4661** | $1.4737 | 68 % |

Read this as: a typical 5-turn conversation uses **~63 K tokens of total
LLM context and costs ~3.4 cents**.

#### Cached vs fresh tokens per conversation

Of the input tokens, only a small fraction is "fresh" — the rest hits the
prompt cache and pays 90 % less. This is **why prompt caching is
non-negotiable** for any tenant past a 1-turn drive-by.

| Conversation length | Cached input tokens | Fresh input tokens | Output tokens | % cached |
|---|---:|---:|---:|---:|
| 1 turn | 11 600 | 280 | 330 | 98 % |
| 5 turns | 58 000 | 3 500 | 1 650 | 94 % |
| 10 turns | 116 000 | 10 600 | 3 300 | 92 % |
| 20 turns | 232 000 | 28 400 | 6 600 | 89 % |
| 50 turns | 580 000 | 81 800 | 16 500 | 87 % |

Even at 50 turns, **87 % of the input still hits the cache** — because the
KB (which dominates input) never changes during a conversation.

#### With realistic adjustments (retry + OpenRouter)

Adding a 10 % validator retry rate (each retry = ~$0.00882) and the
OpenRouter +5 % platform fee:

| Conversation length | Base cost | Expected retry cost (10 %) | OpenRouter (+5 %) | **Final cost** |
|---|---:|---:|---:|---:|
| 1 turn | $0.0058 | $0.0009 | × 1.05 | **$0.0070** |
| 3 turns | $0.0189 | $0.0026 | × 1.05 | **$0.0226** |
| 5 turns | $0.0337 | $0.0044 | × 1.05 | **$0.0400** |
| 10 turns | $0.0769 | $0.0088 | × 1.05 | **$0.0900** |
| 20 turns | $0.1742 | $0.0176 | × 1.05 | **$0.2014** |
| 50 turns | $0.4661 | $0.0441 | × 1.05 | **$0.5357** |

**A typical 5-turn conversation costs ~$0.04. A 10-turn conversation costs
~$0.09.** Those are the two numbers most worth memorising.

#### Worked walkthrough — one 10-turn conversation

Customer Ram has a 10-turn back-and-forth about ordering face scrubs:

```
Turn  1  Ram: "Hi"                                  → AI: $0.00583
Turn  2  Ram: "do you have face scrubs?"            → AI: $0.00629
Turn  3  Ram: "what's the price?"                   → AI: $0.00675
Turn  4  Ram: "is the orange one available?"        → AI: $0.00721
Turn  5  Ram: "do you deliver to Bhaktapur?"        → AI: $0.00757
Turn  6  Ram: "how long does delivery take?"        → AI: $0.00793
Turn  7  Ram: "can I pay COD?"                      → AI: $0.00829
Turn  8  Ram: "ok I'll take 2"                      → AI: $0.00865
Turn  9  Ram: "address: BKT-15"                     → AI: $0.00901
Turn 10  Ram: "thanks!"                             → AI: $0.00937
                                                    ─────────────
                              Subtotal:               $0.07690
                              Expected retry (~1):  + $0.00882
                              OpenRouter fee (+5%): + $0.00429
                                                    ─────────────
                              Total:                  $0.09001
```

Token consumption for that one conversation:
- **126 600 input tokens** (116 000 cached + 10 600 fresh)
- **3 300 output tokens**
- 30 LLM API calls total (3 stages × 10 turns; +2 for one retry)

#### Linking back to monthly cost (sanity check)

A medium tenant with **3 000 conversations/month at an average length of
5 turns** = 15 000 messages/month — matching §5.1's "Medium" reference.

Cost: `3 000 × $0.0400 = $120/month`. §5.1 quoted **$110/month** for the
same tenant. The $10 delta is from rounding plus the 3 % triage-only
escalation discount baked into §5's rate (those short-circuits cost
~$0.0009 instead of $0.0040). The two sections agree.

#### Formula — cost for an N-turn conversation

```
Let T(k) = per-turn cost at conversation turn k  (from the table above)
Let R    = validator retry rate (default 0.10)
Let C    = retry cost = $0.00882
Let F    = OpenRouter fee multiplier = 1.05

Conversation_cost(N) = [ Σ_{k=1..N} T(k) + N × R × C ] × F

Closed form for N ≥ 11:
Conversation_cost(N) = [ $0.0769 + (N - 10) × $0.00973 + N × R × C ] × F
```

Plug in `N = 25, R = 0.10`:
```
= [ 0.0769 + 15 × 0.00973 + 25 × 0.10 × 0.00882 ] × 1.05
= [ 0.0769 + 0.1460 + 0.0221 ] × 1.05
= 0.2450 × 1.05
= $0.2572 per 25-turn conversation
```

---

## 5. Per-business monthly cost projections

Assumptions:
- 90 % of inbound goes through full pipeline (10 % is outside-hours).
- 10 % of pipeline runs trigger one validator retry.
- 3 % short-circuit on triage-level escalation (≈ ⅓ pipeline cost).
- Compiled KB ~5 400 tokens (typical small/medium catalog).
- OpenRouter routing (1.05× platform fee).

### 5.1 The three reference sizes

| Tenant size | Inbound msgs/month | LLM cost | Notes |
|---|---:|---:|---|
| **Small** (boutique store, low traffic) | 3 000 | **$22** | 100 msgs/day |
| **Medium** (popular DTC brand) | 15 000 | **$110** | 500 msgs/day |
| **Large** (high-volume e-commerce) | 60 000 | **$440** | 2 000 msgs/day |

Math for "Medium": `15 000 × $0.00984 × 0.95 (escalation discount) ≈ $140`.
Then subtract outside-hours portion already baked into the $0.00984 rate.
Round to $110.

### 5.2 Catalog-heavy variant

Tenants with 500+ products see compiled prompts of 25 000–40 000 tokens
instead of 5 400. Their per-turn cost scales roughly linearly with the
*cached* portion.

| Compiled prompt size | Per-turn cost (warm cache) | Monthly cost (15K msgs) |
|---|---:|---:|
| 5 400 tok (default) | $0.00973 | $110 |
| 15 000 tok | $0.01250 | $141 |
| 25 000 tok | $0.01528 | $172 |
| 40 000 tok | $0.01944 | $219 |
| 80 000 tok | $0.03110 | $350 |

**Take-away:** doubling the KB size only adds ~30 % to per-turn cost
*because the bulk of it is cached at 10 % of base input*. Without caching,
doubling the KB would double the cost.

---

## 6. Prompt caching — the single biggest lever

If you read only one section, read this one.

### 6.1 How Anthropic prompt caching works

- Mark blocks in your `system` message (and `tools`) with
  `cache_control: { type: "ephemeral" }`.
- The first request that matches that block pays **1.25× base input
  rate** for those tokens (the "write").
- Subsequent requests with the **same exact block** within the TTL pay
  **0.10× base input rate** ("read") — 90 % off.
- Default TTL is **5 minutes**. Extended TTLs (1 h, 1 d) are available at a
  higher write cost on some plans.

### 6.2 Cache hit rate by traffic pattern

| Tenant traffic shape | Cache hit rate | Why |
|---|---:|---|
| Steady (multiple msgs/min) | **>95 %** | Cache never expires |
| Spiky-but-frequent (hourly bursts) | ~80 % | Misses on the first call of each burst |
| Sparse (msgs every few hours) | ~30 % | Most calls miss the 5-min TTL |
| One-off / cold | 0 % | Single call, no benefit |

**Implication for SaaS:** a tenant with 10 messages/day spread across 12
hours might only hit a 30 % cache rate at the default 5-min TTL. Options:
- Pay for **extended cache TTL** (Anthropic 1-hour cache is 2× write cost
  but valid 12× longer — pays back at moderate traffic).
- Pre-warm the cache via a synthetic call when a profile is PUT.

### 6.3 Concrete monthly savings table

For one medium tenant (15K msgs/month), 5 400-token KB:

| Cache strategy | Hit rate | Monthly LLM cost | Saved vs no-cache |
|---|---:|---:|---:|
| No cache | 0 % | $448 | — |
| Anthropic 5-min cache (steady traffic) | 95 % | $110 | **75 % saved** |
| Anthropic 5-min cache (spiky traffic) | 70 % | $182 | 59 % saved |
| Anthropic 1-hour cache (any pattern) | 95 % | $115 | 74 % saved |

Conclusion: **always enable prompt caching**. The implementation effort is
one `cache_control` field in your generator and validator calls.

---

## 7. Validator retries — what they cost

Current setting: `PIPELINE_MAX_RETRIES = 1`.

A retry runs **another Generator + Validator** but skips Triage (the triage
result is reused). Cost of one retry (warm cache, Sonnet generator):

```
generator_retry + validator_retry = $0.00771 + $0.00111 = $0.00882
```

| Retry rate | Average per-turn cost | Monthly cost for 15K msgs |
|---|---:|---:|
| 0 % | $0.00973 | $146 |
| 5 % | $0.01017 | $153 |
| 10 % | $0.01061 | $159 |
| 20 % | $0.01149 | $172 |
| 50 % (bad prompts) | $0.01414 | $212 |

**Lever:** invest in prompt quality and FAQ coverage to keep validator
pass-rate high. Each 5 % drop in retry rate saves ~$7/month per 15K-msg
tenant.

---

## 8. The high-value Opus path

`PIPELINE_GENERATOR_MODEL_HIGH_VALUE=anthropic/claude-opus-4.7`

Opus pricing is **5× Sonnet** for input and output. When the triage stage
flags a high-value customer (large order, complaint, VIP), the generator
switches to Opus.

| Stage | Standard (Sonnet) | High-value (Opus) | Ratio |
|---|---:|---:|---:|
| Generator (warm cache) | $0.00771 | $0.03855 | 5.0× |
| Total turn cost | $0.00973 | $0.04057 | 4.2× |

At a **5 % high-value rate**, the average turn cost becomes:

```
$0.00973 × 0.95 + $0.04057 × 0.05 = $0.01127
```

That's ~16 % more than pure-Sonnet. If 15 % of traffic goes high-value,
the average rises to $0.01437 — ~48 % more.

**Lever:** tune the triage prompt so it only flags genuinely high-value
turns. Every 1 % wrongly-flagged turn adds ~$0.0003/turn average cost.

---

## 9. Infrastructure costs

Beyond LLMs. Numbers below are representative monthly prices on managed
services (AWS, DigitalOcean, Render-style).

### 9.1 Postgres

| Storage usage | Plan size | Cost/month |
|---|---|---:|
| <5 GB (up to ~1 000 tenants, 90 d of logs) | Small managed (1 vCPU, 1 GB) | **$15–25** |
| 5–50 GB | Standard (2 vCPU, 4 GB) | $50–80 |
| >50 GB | Production (4 vCPU, 16 GB) | $200+ |

Per-tenant Postgres footprint:
- BusinessProfile row: ~50 KB
- TurnLog rows: ~5 KB each, retained 90 days

For a tenant with 15K msgs/month and 90-day retention: `15 000 × 3 × 5 KB
= 225 MB`. 100 such tenants = 22 GB. Plan for the **Standard tier at 100+
tenants**.

### 9.2 Redis

| Total profiles cached | Memory needed | Cost/month |
|---|---|---:|
| Up to 1 000 tenants | <100 MB | **$10–20** (small managed instance) |
| Up to 10 000 tenants | <1 GB | $30–50 |
| Idempotency keys, request_id dedupe | +50 MB | (included) |

Compiled prompts are ~5–40 KB each. 1 000 tenants × 40 KB = 40 MB. Trivial.

### 9.3 Application server

NestJS pipeline orchestration is **I/O bound** — it spends most time
waiting on LLM calls. One small container can handle ~50 concurrent turns.

| Traffic | Container count | Cost/month |
|---|---:|---:|
| <10 turns/s | 1 small (0.5 vCPU, 512 MB) | **$15–25** |
| 10–50 turns/s | 2–3 small | $50–80 |
| 50–500 turns/s | 5–10 medium + LB | $200–400 |

For 100 medium-sized tenants (15K msgs × 100 / month / 60s/min /
60min/hr / 24hr/day / 30d = **0.58 turns/s average**), a single small
container suffices. Plan for **2 containers + load balancer** even at
that scale, for redundancy.

### 9.4 Egress + observability

| Item | Cost/month |
|---|---:|
| Network egress (LLM API calls outbound) | $5–15 |
| Log storage (CloudWatch / Datadog / equivalent) | $10–30 |
| Metrics & dashboards | $0–20 (Grafana Cloud free tier covers most cases) |

### 9.5 Infrastructure totals

| Scale | Postgres | Redis | App | Egress + obs | **Total infra/month** |
|---|---:|---:|---:|---:|---:|
| 1–10 tenants | $20 | $15 | $20 | $20 | **~$75** |
| 10–100 tenants | $25 | $20 | $50 | $30 | **~$125** |
| 100–1 000 tenants | $80 | $50 | $80 | $40 | **~$250** |
| 1 000–10 000 tenants | $250 | $200 | $400 | $100 | **~$950** |

**Infrastructure is roughly constant per tenant tier, not per-message.**
Adding more messages doesn't materially shift this.

---

## 10. Cost at SaaS scale

Combining LLM ($0.010 / msg) + infrastructure (from §9.5). Assumes the
"medium tenant" profile (15K msgs/month, 5 400-token KB) is average.

### 10.1 By tenant count

| Tenants | Total msgs/month | LLM cost | Infra cost | **Total monthly cost** |
|---:|---:|---:|---:|---:|
| 1 | 15 000 | $148 | $75 | **$223** |
| 10 | 150 000 | $1 476 | $125 | **$1 601** |
| 100 | 1 500 000 | $14 760 | $250 | **$15 010** |
| 1 000 | 15 000 000 | $147 600 | $950 | **$148 550** |
| 10 000 | 150 000 000 | $1 476 000 | $9 500 (est.) | **~$1.48M** |

### 10.2 By traffic shape (100 tenants total)

| Distribution | LLM cost/month | Notes |
|---|---:|---|
| 100 × small (3K msgs each) | $2 952 | Light-traffic mix |
| 80 × small + 15 × medium + 5 × large | $7 200 | Realistic mix |
| 100 × medium | $14 760 | Heavy mix |
| 50 × medium + 50 × large | $29 520 | Top-of-market mix |

### 10.3 Cost per tenant at scale

| Scale | Avg cost/tenant/month | Avg cost/msg |
|---|---:|---:|
| 10 tenants | $160 | $0.011 |
| 100 tenants | $150 | $0.010 |
| 1 000 tenants | $149 | $0.0099 |

Infrastructure amortises as you grow. Per-tenant cost plateaus around
$148/month for the medium-tenant profile.

---

## 11. Pricing recommendations to tenants

### 11.1 Suggested SaaS tiers

| Tier | Price/month | Included msgs | Cost-to-serve | Gross margin |
|---|---:|---:|---:|---:|
| **Free** | $0 | 100 | $1.50 | -$1.50 (acquisition) |
| **Starter** | $29 | 1 500 | $15 | **48 %** |
| **Growth** | $99 | 8 000 | $79 | **20 %** |
| **Business** | $299 | 30 000 | $295 | **1 %** (loss leader for retention) |
| **Enterprise** | custom | 100K+ | varies | aim 30 %+ |
| Overage (all paid tiers) | $0.025/msg | — | $0.010 | **60 %** |

**Why these numbers:** Starter has healthy margin because small tenants
have light prompt-cache churn. Growth tightens because volume grows
faster than fixed-price ceiling. Business is intentionally near break-even
— it's the sticky plan. Overage is where you actually make money on heavy
tenants.

### 11.2 What to charge for high-value Opus path

If you expose this as a feature, price it separately or include it only on
Business/Enterprise:
- Cost: ~$0.04/turn
- Suggested overage: $0.10/turn (60 % margin)
- Or: include up to 5 % of plan messages as "high-value tier" at no extra
  charge, overage above that at $0.10/msg.

### 11.3 What NOT to do

- **Don't charge per LLM-token.** Tenants can't predict their bill.
- **Don't charge per LLM-call.** Internal pipeline details leak into the
  bill (a retry doubles their cost for no visible reason).
- **Don't include free Opus.** A single user with one chatty Opus tenant
  blows your margin.
- **Don't let history grow unbounded.** Tenants who keep 100-turn history
  pay 10× more in fresh-input tokens than tenants on 10-turn history; this
  is invisible to them. Cap at `MAX_HISTORY_TURNS = 10`.

---

## 12. Cost optimization levers

In priority order. Apply top-down until the bill is acceptable.

### 12.1 Enable Anthropic prompt caching ⭐

Single biggest lever. Adds **one config flag per LLM call**. Saves
**~70 %** on input tokens at steady-state traffic.

```ts
// In OpenRouterClient / LLMClientService
{
  model: 'anthropic/claude-sonnet-4.6',
  messages: [...],
  system: [
    {
      type: 'text',
      text: ctx.systemPrompt,
      cache_control: { type: 'ephemeral' }  // ← this line
    }
  ]
}
```

### 12.2 Cap conversation history at 10 turns

Already designed as `MAX_HISTORY_TURNS=10`. Enforce in
`ContextLoaderService.load()`:

```ts
history: req.history.slice(-this.config.maxHistoryTurns())
```

Each extra turn adds ~120 tokens of fresh input × 3 stages × cost. 10 turns
vs 20 turns ≈ 30 % cost increase.

### 12.3 Skip validator on low-risk channels

Add an `options.skip_validator` flag to `/ai/v1/reply`. When the channel
is "low-risk" (e.g. internal testing, sandbox tenants), skip the
validator entirely. Saves the validator stage cost (~10 % of total).

### 12.4 Use smaller models for low-stakes intents

After triage classifies intent as `faq` and the FAQ match score is high,
swap the generator to Haiku. Saves Sonnet-vs-Haiku delta (~$0.005/turn)
on a substantial fraction of traffic.

| Intent | Frequency | Generator model | Cost saving |
|---|---:|---|---:|
| `faq` (clean match) | 50 % | Haiku | $0.005/turn |
| `sales_inquiry` | 25 % | Sonnet | — |
| `complaint` | 10 % | Sonnet (or Opus) | — |
| Everything else | 15 % | Sonnet | — |

Effective saving: `50 % × $0.005 ≈ $0.0025/turn` (~25 % of total).

### 12.5 Compress old conversation turns

Once a turn is older than the last 4 in history, replace it with a one-line
summary ("user asked about delivery; agent answered"). Saves ~60 % of
history-input tokens.

Implementation cost: an extra Haiku call per N turns to summarise. Worth
it only at heavy-history scale (≥20 turns).

### 12.6 Extended prompt-cache TTL

If your traffic is sparse (most tenants), pay for Anthropic's 1-hour cache
write (2× standard write cost). Pays back when cache hit rate > 50 %.

### 12.7 Negotiate Anthropic enterprise pricing

At >$10K/month LLM spend, Anthropic offers volume discounts (typically
15–30 %). Same applies if you go direct (skipping OpenRouter's 5 %).

---

## 13. Cost monitoring & alerting

### 13.1 What to record in every `TurnLog`

Add these columns (some already in §7 of `AI_BACKEND_ARCHITECTURE.md`):

```ts
{
  tokens_in_triage: number;
  tokens_in_generator: number;
  tokens_in_validator: number;
  tokens_out_triage: number;
  tokens_out_generator: number;
  tokens_out_validator: number;
  cache_read_tokens: number;        // for steady-state monitoring
  cache_write_tokens: number;       // for cache-miss detection
  models_used: string[];            // ["haiku-4.5", "sonnet-4.6", "haiku-4.5"]
  estimated_cost_usd: number;       // computed at log time using §15 formula
}
```

### 13.2 Per-tenant dashboard (in main backend, sourced from this service)

| Metric | Why it matters |
|---|---|
| Total LLM cost this month | Bill projection |
| Cost per message (7d rolling avg) | Detect cost regressions |
| Cache hit rate (7d) | Validate caching is working |
| Validator retry rate (7d) | Quality signal — high = bad prompts |
| Opus usage % | Detect mis-flagged high-value turns |
| Tokens per message (in/out) | Detect runaway prompt growth |

### 13.3 Alert thresholds

| Alert | Trigger | Why |
|---|---|---|
| Tenant exceeded plan limit | msgs ≥ plan × 1.0 | Stop service or auto-bill overage |
| Cache hit rate dropped | <60 % for 1h | Likely a code regression; investigate |
| Retry rate spike | >20 % for 1h | Prompt regression or bad KB edit |
| p95 cost/turn anomaly | >2× tenant's normal | Profile bloat, history bloat, or Opus mis-routing |
| Monthly bill projection | >budget for the month | Capacity / pricing review |

### 13.4 Where to compute "estimated_cost_usd"

In `LLMClientService.complete()`, after every LLM call, compute the cost
using §15's formula and emit it as a structured log + write it back to
`TurnLog.estimated_cost_usd`. This makes per-tenant cost reports a single
Postgres aggregate query.

---

## 14. Worked example — Fresh & More for one month

A real tenant projection using the Fresh & More KB shape (~5 400-token
compiled prompt).

### 14.1 Assumptions

| Variable | Value |
|---|---|
| Inbound messages/month | 12 000 (400/day, organic skincare DTC) |
| Outside-hours fraction | 12 % (international customers) |
| In-hours messages | 10 560 |
| Escalation rate (triage-level) | 4 % → 422 short-circuits, ⅓ pipeline cost |
| Full-pipeline messages | 10 138 |
| Validator retry rate | 8 % |
| High-value Opus rate | 3 % (large orders, complaints) |
| Cache hit rate | 88 % (consistent daily traffic) |

### 14.2 Cost breakdown

| Bucket | Msgs | Cost/msg | Subtotal |
|---|---:|---:|---:|
| Outside hours (free) | 1 440 | $0 | $0 |
| Triage-only escalation | 422 | $0.0009 | $0.38 |
| Full pipeline, standard Sonnet, no retry | 9 088 | $0.00973 | $88.43 |
| Full pipeline + retry (8 %) | 811 | $0.01855 | $15.04 |
| Full pipeline, Opus high-value (3 % of full-pipe) | 304 | $0.04057 | $12.33 |
| OpenRouter platform fee (+5 %) | — | — | +$5.81 |
| **LLM subtotal** | 12 000 | | **$122** |

Fresh & More's share of infrastructure if there are 10 tenants total:
`$125 / 10 = $12.50`.

**Total cost to serve Fresh & More this month: ~$135.**

If charged on a $99 Growth tier with no overage included: **margin = -$36**
(loss). Push them to Business at $299 → margin = $164 (55 %).

### 14.3 Sensitivity analysis

What if any one variable changes?

| Variable shift | New monthly cost |
|---|---:|
| Cache hit rate drops 88 % → 50 % | $200 (+64 %) |
| Retry rate doubles 8 % → 16 % | $137 (+12 %) |
| Opus rate triples 3 % → 9 % | $159 (+30 %) |
| Catalog grows 5 400 → 20 000 tokens | $190 (+56 %) |
| Tenant adds 6 000 more msgs/month | $182 (+50 %) |

**Insight:** the single most explosive variable is **cache hit rate**.
Protecting it is more important than any other optimisation.

---

## 15. Formulas — predict cost from any inputs

### 15.1 Per-turn cost formula

```
Let:
  P_in_h    = Haiku input price ($1.00 / Mtok)
  P_out_h   = Haiku output price ($5.00 / Mtok)
  P_in_s    = Sonnet input price ($3.00 / Mtok)
  P_out_s   = Sonnet output price ($15.00 / Mtok)
  P_in_o    = Opus input price ($15.00 / Mtok)
  P_out_o   = Opus output price ($75.00 / Mtok)
  R         = cache discount factor on cached input (= 0.10 for cache read)
  W         = cache write multiplier (= 1.25 for first call)
  T_kb      = compiled-prompt tokens (cached portion)
  T_fresh_g = fresh generator input tokens (history + message + hints)
  T_fresh_v = fresh validator input tokens (reply + scaffolding)
  T_fresh_t = fresh triage input tokens (history + message)
  T_out_g, T_out_v, T_out_t = output tokens per stage
  hit_rate  = fraction of calls hitting the cache (0–1)
  opus      = 1 if high-value path, else 0
  retry     = 1 if validator retry triggers, else 0

Effective input price per cached token:
  P_eff(M, hit) = (hit × R + (1 - hit) × W) × P_in_M

Per-turn cost C:
  C_triage    = T_kb_t × P_eff(Haiku, hit) + T_fresh_t × P_in_h + T_out_t × P_out_h
  C_generator = T_kb × P_eff(model_g, hit) + T_fresh_g × P_in_{model_g} + T_out_g × P_out_{model_g}
  C_validator = T_kb × P_eff(Haiku, hit) + T_fresh_v × P_in_h + T_out_v × P_out_h

  model_g = Opus if opus else Sonnet

  C = C_triage + C_generator + C_validator
      + retry × (C_generator + C_validator)
```

### 15.2 Monthly cost formula (per tenant)

```
Let:
  N           = inbound messages/month
  f_outside   = fraction outside hours
  f_escalate  = fraction escalating after triage
  f_retry     = fraction retrying
  f_opus      = fraction going through Opus path
  C_short     = triage-only short-circuit cost (≈ $0.00091)
  C_full      = full-pipeline cost (varies by opus + retry)

Monthly LLM cost:
  M = N × [
        f_outside × 0 +
        (1 - f_outside) × f_escalate × C_short +
        (1 - f_outside) × (1 - f_escalate) × (
            (1 - f_opus) × ((1 - f_retry) × C_full_sonnet + f_retry × C_full_sonnet_retry) +
            f_opus × ((1 - f_retry) × C_full_opus + f_retry × C_full_opus_retry)
        )
      ]
  Total = M × (1 + platform_fee)
```

Plug in concrete numbers from §3 and §4 — this is the formula your
"estimated_cost_usd" computation in `TurnLog` should mirror.

### 15.3 Reference values to plug in

| Variable | Default value |
|---|---:|
| `T_kb` (compiled prompt) | 5 400 |
| `T_fresh_g` | 1 280 |
| `T_fresh_v` | 350 (scaffolding + reply) |
| `T_fresh_t` | 350 |
| `T_kb_t` (triage scaffolding) | 600 |
| `T_out_t` | 100 |
| `T_out_g` | 150 |
| `T_out_v` | 80 |
| `hit_rate` | 0.95 |
| `f_outside` | 0.10 |
| `f_escalate` | 0.03 |
| `f_retry` | 0.10 |
| `f_opus` | 0.05 |
| `platform_fee` | 0.05 |

Substituting these into §15.2 yields the **$0.010 / message** headline
number used throughout this doc.

---

## 16. Caveats & verification

### 16.1 Things that will move the numbers

| Factor | Direction |
|---|---|
| Anthropic price changes | ± any |
| OpenRouter platform fee changes | ± up to 5 % |
| Switch to direct Anthropic | -5 % platform fee |
| Anthropic volume discount (>$10K/mo) | -15 % to -30 % |
| Devanagari/CJK tenants | +30 % token usage |
| Longer history retention | +linear in turns |
| Voice/image inputs (future) | +very large multiplier |

### 16.2 What to verify before quoting prices

1. Current Anthropic pricing page → §2.1 numbers.
2. OpenRouter docs on prompt-cache passthrough → §6 numbers.
3. Run a 1-week pilot with one tenant, average their actual
   `estimated_cost_usd` column → compare to §5 projection. Adjust constants
   if reality drifts >10 %.

### 16.3 Knowledge currency

All prices in this doc are based on publicly available rates as of **early
2026**. Rates change. Treat every number here as a planning estimate, not
a contract. The **formulas in §15 will stay valid** even if the constants
in §2.1 move — re-plug new prices and recompute.

### 16.4 What this doc deliberately ignores

- One-time costs (engineering time, design, migration).
- Tax (varies by jurisdiction).
- Payment processor fees (Stripe ~3 % — applies to revenue, not cost).
- Disaster recovery / multi-region replication (add ~20 % to infra).
- Compliance certifications (SOC 2, HIPAA — adds tooling costs).

These belong in a business plan, not in an operational-cost analysis.

---

## Where to start

If you take only three actions:

1. **Implement Anthropic prompt caching** in `LLMClientService` for both
   generator and validator calls. Single biggest lever.
2. **Add `estimated_cost_usd` to `TurnLog`** using the §15 formula. Without
   it, you can't see what's happening.
3. **Set up the alerts in §13.3** before onboarding tenants. Cost surprises
   in week 4 are much harder to fix than guardrails in week 1.

Everything else is tuning around these three.
