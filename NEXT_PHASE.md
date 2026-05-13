# Chatblix `nest-backend` — Phase Review & Next-Phase Plan

_Snapshot date: 2026-05-12_

---

## 1. Where we are today (Phase 1 — Pipeline Port + Streaming MVP)

The NestJS service ports the legacy multi-model CSR agent into a structured,
streaming, prompt-cached LLM pipeline. It is functional end-to-end for a
single-tenant chat surface.

### 1.1 Implemented

**Pipeline (`src/pipeline`)**
- Three-stage LLM pipeline: **Triage → Generator → Validator**, configurable
  retry budget (`PIPELINE_MAX_RETRIES`, default 1).
- Per-stage models routed independently via OpenRouter
  (`anthropic/claude-haiku-4.5` triage/validator, `claude-sonnet-4.6` generator,
  `claude-opus-4.7` high-value generator).
- `OpenRouterClient` with:
  - Ephemeral prompt-cache hints on system messages.
  - Streaming SSE chunk decoder (`chatStream`) and JSON one-shot (`chatJson`).
  - Typed `OpenRouterError` kinds: `timeout`, `api_error`, `no_content`, `config`.
- Validator soft-pass + fallback handoff candidate on unrecoverable generator
  error. "Pick least-bad" attempt selection driven by `severityScore`.
- `PromptsService` warms 3 prompt files (`01_triage.md`, `02_generator.md`,
  `03_validator.md`) at boot, with per-KB substitution
  (`{{BUSINESS_NAME}}` today).
- Two reference KBs on disk: `fresh-and-more.json`, `clothing-store.json`.
- `MetricsService` in-process counters (turns, pass/retry/ship, per-rule
  violation tallies, soft-passes).
- `CorpusService` writes one `TurnLog` row per turn (input, triage, all
  attempts, outcome, intent_path, language, retry_count, high-severity count).

**Chat surface (`src/chat`)**
- `POST /api/chat/stream` — SSE with documented frame sequence
  (`metadata` → `triage` → `token*` → `regenerate?` → `verdict` →
  `metadata?` → `done`).
- `POST /api/chat` — drains the stream into a single JSON payload.
- Deterministic seed momentum + final-momentum reconciliation, contact
  extraction, repeat-reply guard, language inheritance, stalled-count
  bookkeeping in `extracted_data._*`.

**Persistence (`prisma/schema.prisma`)**
- `Lead` (session-keyed), `Message` (chat history), `TurnLog` (corpus).

**Observability**
- `GET /api/health` (config readiness), `GET /api/health/pipeline` (in-process
  counters snapshot), Swagger at `/api/docs`.

**Ops**
- `docker-compose.yml` for local Postgres 15.
- Env validated via `class-validator` (`env.validation.ts`).

### 1.2 Posture / current limits

| Area | Today | Risk if shipped as-is |
|------|-------|------------------------|
| Tenancy | Single-tenant; KB chosen by client via `kb_file`. | Anyone can switch businesses; no per-tenant isolation, quotas, or auth. |
| AuthN/AuthZ | None on `/api/chat*`. | Open relay to OpenRouter; cost & abuse risk. |
| Channels | HTTP only. | "Unified inbox" name implies Messenger / WhatsApp / Instagram / Viber — none wired. |
| Tests | Zero (`*.spec.ts` / `*.test.ts` absent). | Pipeline regressions ship silently. |
| Human handoff | `handoff_required` flag only. | No agent inbox, no notification, no take-over surface. |
| KB management | Static JSON on disk. | Customer onboarding needs an admin UI / API + versioning. |
| Cost / usage | `usage` returned by OpenRouter but discarded. | Cannot bill, rate-limit, or attribute cost per tenant. |
| Observability | In-process counters + per-turn DB log only. | No structured request logs, no traces, no per-tenant dashboards. |
| Rate limiting | None. | Easy to exhaust upstream tokens. |
| Eval / replay | Corpus logged, no offline replay harness. | Prompt edits ship blind. |
| Deploy | Local docker-compose only. | No CI, no staging, no prod config. |
| PII / retention | Plaintext messages, no TTL. | Compliance gap once real customers connect. |

---

## 2. Next phase — proposed scope (Phase 2: "Multi-tenant, channel-ready, evaluable")

**Goal of Phase 2:** turn the working single-tenant pipeline into a service
that a real customer can be onboarded onto, that ingests messages from at
least one external channel, that the operations team can observe and
intervene in, and that we can change prompts on without flying blind.

Non-goals for Phase 2 (push to Phase 3): web admin UI, billing, on-prem
deployments, multi-region, advanced RAG.

### 2.1 Phase 2 themes

1. **Multi-tenancy & auth** — every request is scoped to a `Business`.
2. **Channel adapter (1st: Messenger)** — webhook in, reply out.
3. **Operator surface** — agent inbox API + handoff signalling.
4. **Eval harness** — replay `TurnLog` against new prompts, diff outcomes.
5. **Cost & usage tracking** — capture token usage per turn, per tenant.
6. **Test coverage on the critical path** — unit + integration.
7. **Production hardening** — rate limit, structured logs, CI, staged config.

### 2.2 Milestones (sequenced)

#### M1 — Multi-tenancy foundation _(1–1.5 weeks)_

**Schema changes (`prisma/schema.prisma`)**
- `Business { id, slug, name, kb_json, prompt_overrides_json, created_at }`.
- `ApiKey { id, business_id, hash, label, last_used_at, revoked_at }`.
- Add `business_id` to `Lead`, `Message`, `TurnLog` (+ composite indexes).
- Migrate KBs from `src/pipeline/kb/*.json` into `Business.kb_json` at seed time.

**Code**
- `BusinessModule` + `BusinessService.findByApiKey()`.
- `ApiKeyGuard` (header `X-Chatblix-Key`) attaches `req.business`.
- `PromptsService` reads KB from `Business.kb_json` (filesystem fallback only
  for dev seeding).
- All Prisma queries scoped by `business_id` (Lead, Message, TurnLog).

**Acceptance**
- `POST /api/chat/stream` without/invalid key → 401.
- Two businesses with overlapping `session_id` get isolated history & leads.
- `GET /api/health/pipeline` still works (admin key required).

#### M2 — Messenger channel adapter _(1 week)_

**New module** `src/channels/messenger/`
- `GET /api/channels/messenger/webhook` — verify token handshake.
- `POST /api/channels/messenger/webhook` — verify `X-Hub-Signature-256`,
  enqueue inbound message.
- `MessengerSendService` — call Graph API `messages` with page access token
  from `Business`.
- Map `psid` ↔ `session_id` via new `ChannelIdentity { business_id, channel,
  external_id, session_id }`.

**Worker glue**
- Synchronous-first (no queue yet): webhook → pipeline → send. Add 5s ACK
  timeout escape hatch.

**Acceptance**
- Local ngrok smoke: Messenger message round-trips through pipeline and
  appears in DB scoped to the right `business_id`.

#### M3 — Operator API (handoff surface) _(0.5–1 week)_

- `GET /api/ops/conversations?status=handoff` — paginated open handoffs for
  the caller's business.
- `GET /api/ops/conversations/:session_id` — lead + recent messages + last
  triage/verdict.
- `POST /api/ops/conversations/:session_id/messages` — agent reply, pushed to
  the same channel (Messenger send), stored with `metadata.author = "agent"`.
- `POST /api/ops/conversations/:session_id/resume` — clears `handoff_required`
  and re-engages the bot on the next inbound.

**Acceptance**
- A turn that sets `handoff_required = true` appears in
  `GET /api/ops/conversations?status=handoff`.
- Agent reply lands in the customer's Messenger thread and in `Message`.

#### M4 — Cost & usage tracking _(0.5 week)_

- Add `prompt_tokens`, `completion_tokens`, `cost_usd_micro`, `model`,
  `stage` to a new `LlmCall` table (one row per OpenRouter call, FK to
  `TurnLog`).
- `OpenRouterClient` returns usage; orchestrator persists per-stage rows.
- `GET /api/health/pipeline` adds `tokens_today`, `cost_today_usd` per
  business (cached 30s).

**Acceptance**
- Single chat turn produces 3 `LlmCall` rows (triage, generator,
  validator). `total = sum(stages)` ± rounding.

#### M5 — Eval / replay harness _(1 week)_

- `scripts/replay.ts` — given a date range + `business_id`, re-run every
  `TurnLog` against the current prompts; write to a parallel
  `TurnLogReplay` table.
- Diff report: outcome flips (pass→fail, fail→pass), language flips,
  intent_path flips, severity-score delta histogram.
- `scripts/eval-fixtures/` — 30–50 hand-graded turns covering each rule_id
  the validator emits; CI runs them on every PR (see M7).

**Acceptance**
- Running `pnpm replay --since 2026-05-01 --business <slug>` produces a
  Markdown diff report under `reports/`.

#### M6 — Tests on the critical path _(parallel with M1–M5, ~1 week effort)_

- Unit: `parser.ts`, `momentum.ts`, `language-detector.ts`,
  `extractors.ts`, `severity.ts`, `triage-fallback.ts`, `contracts.ts`.
- Service: `LeadService.updateLeadState` (stage downgrade rule),
  `ChatStreamService` finalization (mock orchestrator stream).
- Integration: `POST /api/chat` end-to-end with `OpenRouterClient` mocked
  via `nock` — assert event sequence and DB writes.

**Coverage target:** 70% lines on `src/common`, 60% on `src/pipeline` and
`src/chat`.

#### M7 — Production hardening _(0.5–1 week)_

- Rate limit: `@nestjs/throttler` per-IP and per-API-key
  (e.g. 30 req/min per session).
- Structured request logger (`pino-http`) with `business_id`, `session_id`,
  `turn_id` correlation.
- OpenTelemetry traces around each pipeline stage (optional, behind flag).
- Dockerfile for the app + GitHub Actions:
  `lint → typecheck → prisma validate → unit tests → eval fixtures`.
- Secrets via env only (no `.env` committed). Confirm `.env` is gitignored —
  currently `.gitignore` is 50 bytes, audit it.
- Message retention: nightly job deletes `TurnLog.input` payloads older than
  90 days, keeps aggregate columns.

---

## 3. Dependencies & ordering

```
M1 (tenancy)  ──┬──> M2 (channel)
                ├──> M3 (operator)
                ├──> M4 (cost)
                └──> M5 (eval)        M6 (tests) runs in parallel
M2 + M3 ─────────> M7 (hardening / deploy gate)
```

**Critical path: M1 → M2 → M3 → M7.** Everything else is parallelizable.

## 4. Risks & open questions

- **Prompt-cache invalidation:** moving KB from filesystem to DB changes the
  cached `system` payload per tenant; expected and fine, but worth measuring
  cache-hit rate before/after in M4.
- **`session_id` semantics across channels:** today the client controls it.
  Once channels are real, the channel adapter must mint and own it — the
  HTTP surface keeps client-controlled IDs but rejects collisions with
  channel-minted ones.
- **Schema migration with `Lead.id = session_id`:** to add `business_id`
  without breaking existing data, either add a unique `(business_id, session_id)`
  pair or rekey `Lead.id` to UUID + index on `(business_id, session_id)`.
  Recommend the latter; do it in M1 before any tenant has real data.
- **Stage downgrade rule in `LeadService.updateLeadState`** silently
  swallows downgrades (cold ← warm) other than `lost`. Confirm with product
  this is still the desired behavior before tests pin it.
- **Validator soft-pass on schema-invalid** masks generator regressions in
  metrics. Decide in M5 whether to count those as failures in eval.
- **Repeat-reply guard threshold (0.85 token overlap)** is untested. M6
  fixtures should pin both true-positive and false-positive cases.

## 5. Acceptance criteria for "Phase 2 done"

1. A new business can be onboarded by inserting one `Business` row + one
   `ApiKey` row — no code changes.
2. A Messenger message from a customer reaches the bot and the bot's reply
   is delivered back, fully scoped to that business.
3. An operator can list their open handoffs, send an agent reply, and
   resume the bot — via HTTP API only (UI is Phase 3).
4. Every turn has a verifiable cost in `LlmCall`; daily total per business
   is queryable.
5. CI blocks merges on lint, typecheck, unit tests, and the eval fixtures.
6. Replay against the last 7 days of `TurnLog` produces a diff report;
   prompt PRs are reviewed with the report attached.

## 6. Suggested first PR

Pick the smallest unblocking slice of M1:

1. Add `Business` + `ApiKey` Prisma models and the migration.
2. Add `business_id` to `Lead`/`Message`/`TurnLog` (nullable in this PR,
   backfilled to a single "default" business).
3. Add `ApiKeyGuard` and apply it to `/api/chat*` only (leave health open).
4. Seed script `prisma/seed.ts` inserts the default business with the
   existing `fresh-and-more.json` KB.

That PR is reviewable, reversible, and unblocks every other M1–M7 task.
