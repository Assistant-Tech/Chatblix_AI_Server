# ai-backend — BullMQ Implementation Plan

## Context

ai-backend currently has:
- Its own PostgreSQL database (BusinessProfile replica + TurnLog)
- HTTP reply endpoints (POST /ai/v1/reply, POST /ai/v1/reply/stream)
- Profile sync HTTP endpoints (PUT/DELETE /ai/v1/businesses/:id)
- Its own Redis for caches

After this implementation:
- **No database** — ai-backend is fully stateless
- **No HTTP reply endpoints** — replaced by a BullMQ Worker
- **No profile sync endpoints** — main-backend writes profile to shared Redis directly
- Profile comes from Redis. TurnLog data is returned in the job result (main-backend writes it).
- All pipeline logic (triage, generator, validator, etc.) is **unchanged**

**Read first:** `../main-backend/docs/BULLMQ_ARCHITECTURE.md`

---

## Phase 0 — Remove Database

All Prisma code is deleted. No migration rollback needed — main-backend owns the schema now.

### Task 0.1 — Delete `prisma/` folder

```bash
rm -rf prisma/
```

Removes: `schema.prisma`, `migrations/`, `migration_lock.toml`.

### Task 0.2 — Remove Prisma dependencies from `package.json`

Remove these packages:

```json
"@prisma/client": "...",
"prisma": "..."
```

Remove these scripts:

```json
"prisma:migrate": "...",
"prisma:deploy": "...",
"prisma:generate": "..."
```

Run:
```bash
pnpm remove @prisma/client prisma
```

### Task 0.3 — Delete `src/prisma/` folder

```bash
rm -rf src/prisma/
```

Removes: `prisma.module.ts`, `prisma.service.ts`.

### Task 0.4 — Remove `DATABASE_URL` from `src/config/env.validation.ts`

Delete the `DATABASE_URL` field from `EnvSchema`.

### Task 0.5 — Remove `databaseUrl()` from `src/config/app-config.service.ts`

Delete the `databaseUrl()` method.

### Task 0.6 — Remove `PrismaModule` from `src/app.module.ts`

Delete the import and the module reference from the `imports` array.

---

## Phase 1 — Remove HTTP Endpoints

### Task 1.1 — Delete `src/business/businesses.controller.ts`

This file handles `PUT /ai/v1/businesses/:id` and `DELETE /ai/v1/businesses/:id`.
These endpoints no longer exist — main-backend writes the profile to Redis directly.

```bash
rm src/business/businesses.controller.ts
```

### Task 1.2 — Remove `upsert()` and `softDelete()` from `src/business/business-profile.service.ts`

Delete these two methods entirely. They received HTTP pushes — no longer needed.

Keep:
- `get(id)` — will be updated in Phase 3
- `getCompiledPrompt(id)` — unchanged

### Task 1.3 — Update `src/business/business.module.ts`

Remove `BusinessesController` from the `controllers` array.
The module now only provides `BusinessProfileService` and `SystemPromptCompilerService`.

### Task 1.4 — Delete `src/reply/reply.controller.ts`

```bash
rm src/reply/reply.controller.ts
```

`POST /ai/v1/reply` and `POST /ai/v1/reply/stream` are no longer HTTP endpoints.
The pipeline is now triggered by the BullMQ Worker (Phase 2).

### Task 1.5 — Update `src/reply/reply.module.ts`

Remove `ReplyController` from the `controllers` array.
Keep `ReplyService` and `ContextLoaderService` as providers — they are still used by the worker.

### Task 1.6 — Delete `src/internal/` folder

```bash
rm -rf src/internal/
```

Removes: `internal.controller.ts`, `internal.service.ts`, `internal.module.ts`.
main-backend now has direct PostgreSQL access to `turn_logs` and handles its own analytics.

### Task 1.7 — Remove `InternalModule` from `src/app.module.ts`

Delete the import and reference from the `imports` array.

### Task 1.8 — Remove `ReplyController` HTTP registration from `src/main.ts`

Check `main.ts` for any explicit controller or route registrations. Remove any
reference to the reply HTTP surface if present. Keep the global API prefix (`ai/v1`)
if it's used by other remaining routes (health check).

---

## Phase 2 — BullMQ Worker

### Task 2.1 — Add BullMQ dependencies

Check if `@nestjs/bullmq` and `bullmq` are already in `package.json`.
If not, install:

```bash
pnpm add @nestjs/bullmq bullmq
```

`ioredis` is already present — no change needed.

### Task 2.2 — Add `BULLMQ_REDIS_URL` to `src/config/env.validation.ts`

```typescript
@IsString()
BULLMQ_REDIS_URL!: string;   // shared Redis where BullMQ jobs live
```

This is **different** from `REDIS_URL` (which is ai-backend's own Redis for caches).

### Task 2.3 — Add `bullmqRedisUrl()` to `src/config/app-config.service.ts`

```typescript
bullmqRedisUrl(): string {
  return this.config.get('BULLMQ_REDIS_URL', { infer: true });
}
```

### Task 2.4 — Create `src/worker/worker.module.ts`

```typescript
@Module({
  imports: [
    BullModule.forRootAsync({
      // Uses BULLMQ_REDIS_URL — the shared Redis, not ai-backend's own Redis
      useFactory: (config: AppConfigService) => ({
        connection: { url: config.bullmqRedisUrl() },
      }),
      inject: [AppConfigService],
    }),
    ReplyModule,    // provides ReplyService
    CacheModule,    // provides ProfileCacheService, PromptCacheService, RequestDedupeService
    BusinessModule, // provides BusinessProfileService (updated to read from Redis)
    PipelineModule, // provides PipelineOrchestratorService and all pipeline services
    ConfigModule,
  ],
  providers: [AiReplyWorker],
})
export class WorkerModule {}
```

### Task 2.5 — Create `src/worker/ai-reply.worker.ts`

This is the BullMQ Worker. It is the new entry point replacing `ReplyController`.

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ReplyService } from '../reply/reply.service';

@Processor('ai:reply', {
  concurrency: 5,
  stalledInterval: 30_000,
  maxStalledCount: 2,
})
export class AiReplyWorker extends WorkerHost {
  constructor(private readonly replyService: ReplyService) {
    super();
  }

  async process(job: Job<AiReplyJobPayload>): Promise<AiReplyJobResult> {
    // ReplyService.handle() already exists and contains all the pipeline logic.
    // It currently returns ReplyResponse. We update it (Phase 4) to also
    // return the TurnLog data.
    const result = await this.replyService.handle(job.data);
    return result;  // { response: ReplyResponse, turnLog: AiTurnLogData }
  }
}
```

Worker connects to `BULLMQ_REDIS_URL` (shared Redis with main-backend).
ai-backend's own Redis (`REDIS_URL`) remains separate for caches.

### Task 2.6 — Register `WorkerModule` in `src/app.module.ts`

Add `WorkerModule` to the `imports` array.

---

## Phase 3 — Profile from Redis (No Database)

### Task 3.1 — Create `src/common/clients/main-backend.client.ts`

HTTP client used **only** when `profile:{tenantId}` is missing from Redis (cold cache).

```typescript
@Injectable()
export class MainBackendClient {
  async getProfile(tenantId: string): Promise<BusinessProfileDto> {
    // GET {MAIN_BACKEND_INTERNAL_URL}/api/v1/internal/businesses/{tenantId}
    // Header: Authorization: Bearer MAIN_BACKEND_INTERNAL_TOKEN
    // Timeout: 5000ms
    // Throws NotFoundException if 404
    // Throws InternalServerErrorException on other errors
  }
}
```

### Task 3.2 — Add cold cache env vars to `src/config/env.validation.ts`

```typescript
@IsString()
MAIN_BACKEND_INTERNAL_URL!: string;

@IsString()
@MinLength(32)
MAIN_BACKEND_INTERNAL_TOKEN!: string;
```

### Task 3.3 — Add accessors to `src/config/app-config.service.ts`

```typescript
mainBackendInternalUrl(): string { ... }
mainBackendInternalToken(): string { ... }
```

### Task 3.4 — Update `src/business/business-profile.service.ts` — `get()` method

Replace the current implementation (which reads from Prisma) with Redis-first logic:

```typescript
async get(id: string): Promise<BusinessProfile> {
  // 1. Try Redis cache (ProfileCacheService)
  const cached = await this.profileCache.get<BusinessProfile>(id);
  if (cached) return cached;

  // 2. Cold cache: fetch from main-backend via HTTP
  const profile = await this.mainBackendClient.getProfile(id);

  // 3. Check aiEnabled — reject if AI is disabled for this tenant
  if (!profile.aiEnabled) {
    throw new NotFoundException({ error: 'business_not_found', business_id: id });
  }

  // 4. Store in Redis for next time (5 min TTL)
  await this.profileCache.set(id, profile);
  return profile as unknown as BusinessProfile;
}
```

Remove all `this.prisma` references from this file.

### Task 3.5 — Remove Prisma import from `src/business/business-profile.service.ts`

Delete: `import { PrismaService } from '../prisma/prisma.service'`
Delete: `private readonly prisma: PrismaService` from constructor.

### Task 3.6 — Inject `MainBackendClient` into `BusinessProfileService`

Add to constructor and to `business.module.ts` providers.

---

## Phase 4 — TurnLog in Job Result

ai-backend no longer writes TurnLog to a database. Instead, it collects TurnLog data
during the pipeline and returns it as part of the job result. main-backend writes it.

### Task 4.1 — Create `src/common/types/turn-log.types.ts`

```typescript
export interface AiTurnLogData {
  status: string;
  triage: object;
  attempts: object;
  validatorPass: boolean;
  retryCount: number;
  highSeverityViolations: number;
  intentPath: string | null;
  language: string | null;
  shipped: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  traceId: string | null;
  modelTriage: string | null;
  modelGenerator: string | null;
  modelValidator: string | null;
}

export interface AiReplyJobResult {
  response: ReplyResponse;
  turnLog: AiTurnLogData;
}
```

### Task 4.2 — Update `src/reply/reply.service.ts` — `handle()` return type

Currently `handle()` returns `Promise<ReplyResponse>`.
Change to `Promise<AiReplyJobResult>`.

In `buildResponse()`:
  - Collect the same data that was previously written to `prisma.turnLog.create()`
  - Return it alongside the response:

```typescript
return {
  response,           // the ReplyResponse (replied | escalate | outside_hours)
  turnLog: {
    status: response.status,
    triage: triage ?? {},
    attempts: done?.attempts ?? [],
    validatorPass: lastAttempt?.verdict?.pass === true,
    retryCount: Math.max(0, (done?.attempts?.length ?? 1) - 1),
    highSeverityViolations: highCount(violations),
    intentPath: triage?.intent_path ?? null,
    language: triage?.language?.detected ?? null,
    shipped: done?.shipped ?? '',
    tokensIn: null,     // captured from OpenRouter usage if available
    tokensOut: null,
    durationMs: latency_ms,
    traceId: req.options?.trace_id ?? null,
    modelTriage: this.config.triageModel(),
    modelGenerator: this.config.generatorModel(),
    modelValidator: this.config.validatorModel(),
  },
};
```

### Task 4.3 — Remove all `prisma.turnLog.create()` calls from `reply.service.ts`

Delete `logTurn()` and `logOutsideHours()` methods entirely.
Delete `private readonly prisma: PrismaService` from constructor.
Delete `PrismaService` import.

### Task 4.4 — Update `stream()` method in `reply.service.ts`

The `stream()` method was used by the SSE endpoint (now deleted).
If you want to keep it for future use (e.g. local testing), update its return type.
If you want a clean codebase, delete it entirely — the worker only calls `handle()`.

---

## Phase 5 — ContextLoaderService Cleanup

`ContextLoaderService` already calls `BusinessProfileService.get()` — which is
updated in Phase 3 to read from Redis. No logic change needed here.

### Task 5.1 — Remove Prisma references from `src/reply/context-loader.service.ts`

Verify there are no direct `this.prisma` calls in this file. If there are, remove them.
The service should only depend on `BusinessProfileService` and `AppConfigService`.

---

## Phase 6 — Update AppModule

### Task 6.1 — Update `src/app.module.ts` imports

**Remove:**
- `PrismaModule`
- `InternalModule`

**Add:**
- `WorkerModule`

**Keep unchanged:**
- `ConfigModule`
- `CacheModule`
- `AuthModule`
- `BusinessModule` (updated — no more DB, no more controller)
- `PipelineModule`
- `ReplyModule` (updated — no more controller, just the service)
- `HealthModule`

---

## Phase 7 — Environment & Config Cleanup

### Task 7.1 — Update `.env.example`

**Remove:**
```
DATABASE_URL=...
```

**Add:**
```
# Shared Redis for BullMQ jobs (same Redis as main-backend)
BULLMQ_REDIS_URL=redis://redis:6379

# main-backend internal API (cold cache profile fetch)
MAIN_BACKEND_INTERNAL_URL=http://main-backend:3000
MAIN_BACKEND_INTERNAL_TOKEN=<same value as AI_INTERNAL_API_TOKEN in main-backend>
```

**Keep unchanged:**
```
PORT=8000
REDIS_URL=redis://ai-redis:6379          # ai-backend's own Redis (caches)
INTERNAL_API_TOKEN=...                   # still used for health endpoint auth if needed
OPENROUTER_API_KEY=...
USE_MULTI_MODEL_PIPELINE=true
PIPELINE_TRIAGE_MODEL=...
PIPELINE_GENERATOR_MODEL=...
PIPELINE_GENERATOR_MODEL_HIGH_VALUE=...
PIPELINE_VALIDATOR_MODEL=...
PIPELINE_TRIAGE_TIMEOUT_MS=4500
PIPELINE_GENERATOR_TIMEOUT_MS=10000
PIPELINE_VALIDATOR_TIMEOUT_MS=4500
PIPELINE_MAX_RETRIES=1
MAX_HISTORY_TURNS=10
```

### Task 7.2 — Update `docker-compose.yml`

**Remove:**
- `ai-postgres` service (PostgreSQL for ai-backend)
- `DATABASE_URL` env var from ai-backend service

**Add:**
- `BULLMQ_REDIS_URL` env var pointing to main-backend's Redis
- `MAIN_BACKEND_INTERNAL_URL` and `MAIN_BACKEND_INTERNAL_TOKEN`

**Keep:**
- `ai-redis` service (ai-backend's own Redis for caches) — OR point `REDIS_URL` to
  the shared Redis if you want to simplify to one Redis. Either works.

---

## Phase 8 — Fix LLMClientService (Known Bug)

This is a pre-existing bug: all three pipeline stages inject `OpenRouterClient` directly
instead of `LLMClientService`, bypassing the retry/backoff logic.

### Task 8.1 — Fix `src/pipeline/triage.service.ts`

Change injection from `OpenRouterClient` to `LLMClientService`.
Update call sites: `this.client.chatJson(...)` → `this.llmClient.chatJson(..., { stage: 'triage', business_id: ctx.business_id })`.

### Task 8.2 — Fix `src/pipeline/generator.service.ts`

Change injection from `OpenRouterClient` to `LLMClientService`.
Update call sites: `this.client.chatStream(...)` → `this.llmClient.chatStream(..., { stage: 'generator' })`.

### Task 8.3 — Fix `src/pipeline/validator.service.ts`

Change injection from `OpenRouterClient` to `LLMClientService`.
Update call sites accordingly.

### Task 8.4 — Fix `src/pipeline/prompt-assembler.service.ts` import

Change:
```typescript
import { Injectable } from '@nestjs/core';   // wrong
```
To:
```typescript
import { Injectable } from '@nestjs/common'; // correct
```

---

## Phase 9 — Testing

### Task 9.1 — Update `ContextLoaderService` unit tests

Replace Prisma mocks with Redis/ProfileCacheService mocks.
Verify that `get()` falls back to `MainBackendClient` on cache miss.

### Task 9.2 — Update `ReplyService` unit tests

Remove TurnLog write assertions (no longer happens in ai-backend).
Add assertion that the returned value includes `turnLog` data.
Verify `turnLog` fields are correctly populated from pipeline output.

### Task 9.3 — Add `AiReplyWorker` unit tests

Mock `ReplyService.handle()`. Verify worker calls it with job data and returns result.
Verify worker configuration: concurrency, stalledInterval.

### Task 9.4 — E2E: worker processes a job end-to-end

Use a test Redis (`BULLMQ_REDIS_URL=redis://localhost:6379/1`).
Enqueue a job manually. Verify worker picks it up, runs the pipeline (mock OpenRouter),
and returns `{ response, turnLog }` as the job result.

### Task 9.5 — Cold cache test

Simulate `profile:{tenantId}` missing from Redis.
Verify `BusinessProfileService.get()` calls `MainBackendClient.getProfile()`.
Verify the fetched profile is stored back in Redis.

---

## Phase 10 — Complete Removal & Cleanup Audit

This phase documents every file, method, injection, package, and piece of dead code
that must be removed. Go through this list completely — these are not optional.

---

### 10.A — Files to Delete Entirely

```
FOLDER / FILE                                  REASON
─────────────────────────────────────────────────────────────────────────────────────
prisma/schema.prisma                           ai-backend owns no DB schema
prisma/migrations/                             all migrations owned by main-backend
prisma/migration_lock.toml                     same

src/prisma/prisma.module.ts                    no DB = no Prisma module
src/prisma/prisma.service.ts                   same

src/business/businesses.controller.ts          PUT/DELETE /ai/v1/businesses/:id removed
                                               main-backend writes profile to Redis directly

src/internal/internal.controller.ts            GET /ai/v1/internal/turns, /stats/* removed
src/internal/internal.service.ts               all DB queries, nothing to query now
src/internal/internal.module.ts                module with nothing left

src/reply/reply.controller.ts                  POST /ai/v1/reply and /reply/stream removed
                                               replaced by BullMQ Worker

src/pipeline/prompt-assembler.service.ts       DEAD CODE — never called by any service.
                                               ContextLoaderService loads ctx.systemPrompt
                                               but no pipeline service reads it. This was
                                               the intended consumer but was never wired.
```

---

### 10.B — Methods to Delete Inside Files That Stay

#### `src/reply/reply.service.ts`

| Method / Symbol | Why |
|---|---|
| `stream()` async generator | SSE streaming endpoint is deleted. No caller. |
| `logTurn()` private method | Wrote to `prisma.turnLog`. DB is gone. Data returned in job result instead. |
| `logOutsideHours()` private method | Same reason as above. |
| `ReplyTokenChunk` interface | Only used by `stream()`. |
| `ReplyDoneChunk` interface | Only used by `stream()`. |
| `ReplyStreamChunk` type alias | Only used by `stream()`. |
| `CollectedTurn.tokens: string[]` field | Populated inside `stream()` only. |

#### `src/business/business-profile.service.ts`

| Method / Symbol | Why |
|---|---|
| `upsert()` | Received HTTP push from main-backend. No longer called. main-backend writes to Redis directly. |
| `softDelete()` | Received HTTP DELETE from main-backend. Same reason. |
| `UpsertResult` interface | Return type of `upsert()`, deleted above. |

---

### 10.C — Constructor Injections to Remove

#### `src/reply/reply.service.ts` constructor

| Injection | Why |
|---|---|
| `PrismaService` | `logTurn()` and `logOutsideHours()` (deleted) were the only consumers. |
| `RequestDedupeService` | HTTP-era 60s dedupe by `request_id`. BullMQ processes each job once. main-backend's Redis lock (`ai:lock:{convId}`) prevents duplicate enqueueing. Redundant. |

After removing both, also delete:
- `import { PrismaService } from '../prisma/prisma.service'`
- `import { RequestDedupeService } from '../cache/request-dedupe.service'`
- The dedupe `getCached` / `storeOnce` calls in `handle()`

#### `src/business/business-profile.service.ts` constructor

| Injection | Why |
|---|---|
| `PrismaService` | `upsert()` and `softDelete()` (deleted) were the only DB callers. `get()` is being rewritten to use Redis + HTTP fallback. |

---

### 10.D — Module Registrations to Remove

#### `src/app.module.ts`

| Remove | Add |
|---|---|
| `PrismaModule` | `WorkerModule` |
| `InternalModule` | — |

#### `src/business/business.module.ts`

| Remove from `controllers:[]` |
|---|
| `BusinessesController` |

#### `src/reply/reply.module.ts`

| Remove from `controllers:[]` |
|---|
| `ReplyController` |

#### `src/pipeline/pipeline.module.ts`

| Remove from `providers:[]` and `exports:[]` |
|---|
| `PromptAssemblerService` |

#### `src/cache/cache.module.ts`

`RequestDedupeService` **can stay** in CacheModule — it's a generic Redis utility and
costs nothing to keep registered. It is only removed from `ReplyService`'s constructor.
If you want a perfectly clean codebase, remove it from CacheModule too since nothing
injects it anymore.

---

### 10.E — npm Packages to Remove

```bash
pnpm remove @prisma/client prisma
```

Also remove from `package.json` scripts:
```json
"prisma:migrate": "...",    ← delete
"prisma:deploy": "...",     ← delete
"prisma:generate": "..."    ← delete
```

---

### 10.F — `src/main.ts` Cleanup

The Swagger description references endpoints that no longer exist. Update it:

**Remove from Swagger description:**
```
- `PUT /ai/v1/businesses/:id` — upsert a business profile
- `DELETE /ai/v1/businesses/:id` — soft-delete a business profile
- `POST /ai/v1/reply` — generate a reply
- `POST /ai/v1/reply/stream` — SSE-streamed reply
```

**Remove Swagger tags that reference deleted controllers:**
```typescript
.addTag('businesses', 'Business profile push / delete')   // ← delete
.addTag('reply', 'Pipeline reply endpoints')               // ← delete
```

**Remove the body parser limit** — it was for large HTTP reply payloads.
With no body-accepting endpoints, it is dead config:
```typescript
app.useBodyParser('json', { limit: config.maxRequestBytes() });  // ← delete
```

**Consequently remove `MAX_REQUEST_BYTES` from env.validation.ts and app-config.service.ts.**

**Update Swagger description** to reflect the BullMQ architecture:
```typescript
.setDescription(
  'AI pipeline worker. Consumes jobs from the ai:reply BullMQ queue. ' +
  'No HTTP reply surface — all pipeline triggering is queue-based. ' +
  'GET /ai/v1/health is the only active HTTP endpoint.'
)
```

---

### 10.G — Environment Variables to Remove

| Variable | File | Reason |
|---|---|---|
| `DATABASE_URL` | `env.validation.ts`, `app-config.service.ts`, `.env.example`, `docker-compose.yml` | No database |
| `MAX_REQUEST_BYTES` | `env.validation.ts`, `app-config.service.ts`, `.env.example` | No HTTP body endpoints |

**Remove `maxRequestBytes()` from `AppConfigService`.**

---

### 10.H — Pre-existing Dead Code (Fix Now While Touching These Files)

These bugs existed before the BullMQ migration. Fix them during cleanup.

#### Dead: `PromptAssemblerService` and `ctx.systemPrompt`

`ContextLoaderService.load()` calls `this.profiles.getCompiledPrompt()`, which:
1. Calls `SystemPromptCompilerService.compile(profile)` — compiles a rich per-tenant prompt
2. Caches it in Redis as `prompt:{tenantId}`
3. Returns it as `ctx.systemPrompt`

But `ctx.systemPrompt` is **never read by any LLM call**. Triage, generator, and
validator all call `PromptsService.getXxxPrompt()` (static markdown files) instead of
using `ctx.systemPrompt`. `PromptAssemblerService` was supposed to bridge this but was
never wired.

**Two options:**

Option A (recommended for now — less risky): Remove the dead caching work.
- In `src/reply/context-loader.service.ts`: remove the `getCompiledPrompt()` call.
  Remove `systemPrompt` from the returned `ContextPacket`.
- In `src/common/types/pipeline.types.ts`: remove `systemPrompt: string` from
  `ContextPacket` interface.
- Redis key `prompt:{tenantId}` stops being written (the DEL in main-backend becomes a
  harmless no-op, which is fine).

Option B (future — wire it properly): Make triage/generator/validator use
`ctx.systemPrompt` as the system instruction instead of static markdown. This is the
intended final design (`Task 2.2a` referenced in the code comments). Do this in a
separate feature branch, not during cleanup.

**Choose Option A for now. Remove the dead `getCompiledPrompt()` call from
`ContextLoaderService`. Document Option B as a future task.**

---

#### Dead: `LLMClientService` bypassed by all three pipeline stages

`LLMClientService` provides retry/backoff/logging. It wraps `OpenRouterClient`.
But `triage.service.ts`, `generator.service.ts`, and `validator.service.ts` all inject
`OpenRouterClient` directly, bypassing `LLMClientService` entirely.

**This is Phase 8 in the implementation plan.** Fix all three services to inject
`LLMClientService` instead of `OpenRouterClient`. This activates the retry logic that
has been dead since the service was written.

---

#### Dead: `void ctx` at end of `logTurn()` and `logOutsideHours()`

Both methods accept `ctx: ContextPacket` but never use it. The `void ctx` statement
suppresses the TypeScript unused-variable warning.

**These methods are deleted in Phase 4, so this fixes itself.**

---

#### Dead: `tokens: string[]` in `CollectedTurn` (streaming accumulation)

Inside `stream()`, tokens are accumulated in `c.tokens` for potential use.
In `handle()`, `CollectedTurn.tokens` is initialized but never read.
The streaming tokens were for the SSE endpoint (deleted).

**`stream()` is deleted in Phase 4, so this fixes itself.**

---

### 10.I — What `RequestDedupeService` Was Protecting Against (and Why It's Safe to Remove)

**Original purpose:** If the HTTP endpoint `POST /ai/v1/reply` received the same
`request_id` twice within 60 seconds (network retry, duplicate webhook), it returned
the cached response without re-running the pipeline.

**Why it's safe to remove now:**
1. There is no HTTP endpoint. Jobs come from BullMQ.
2. main-backend uses `ai:lock:{conversationId}` (Redis SETNX) before enqueuing.
   Only one job per conversation can be in-flight at a time.
3. BullMQ processes each job exactly once. There is no "send same job twice" scenario
   unless main-backend explicitly enqueues twice (which the lock prevents).
4. If you want job-level dedup, set `jobId: request_id` when calling `queue.add()` in
   main-backend. BullMQ will reject a duplicate job with the same ID automatically.

**Remove `RequestDedupeService` injection from `ReplyService`.** The service can remain
registered in `CacheModule` as a utility for future use, but it has no active consumer.

---

## Complete File Inventory — Final State

After all phases complete, ai-backend looks like this:

```
KEPT (zero or minimal changes)         MODIFIED                DELETED
──────────────────────────────────     ─────────────────────   ────────────────────────
src/auth/auth.module.ts                src/app.module.ts       prisma/
src/auth/internal-token.guard.ts       src/main.ts             src/prisma/
src/auth/public.decorator.ts           src/config/             src/internal/
src/health/health.controller.ts          env.validation.ts     src/business/
src/health/health.module.ts              app-config.service.ts   businesses.controller.ts
                                       src/business/           src/reply/
src/pipeline/ (logic unchanged)          business.module.ts      reply.controller.ts
  orchestrator.service.ts               business-profile        src/pipeline/
  triage.service.ts  ← fix inject         .service.ts            prompt-assembler.service.ts
  generator.service.ts ← fix inject   src/reply/
  validator.service.ts ← fix inject     reply.module.ts
  hours.service.ts                      reply.service.ts
  escalation-rules.service.ts             (remove stream,
  tone-checker.service.ts                  logTurn,
  safety-filter.service.ts                 logOutsideHours)
  response-cleaner.service.ts         src/reply/
  llm-client.service.ts                 context-loader.service.ts
  openrouter.client.ts                    (remove systemPrompt)
  prompts.service.ts                  .env.example
  metrics.service.ts                  docker-compose.yml
  prompts/01_triage.md
  prompts/02_generator.md
  prompts/03_validator.md

src/cache/
  redis.client.ts
  cache.module.ts
  profile-cache.service.ts
  prompt-cache.service.ts
  request-dedupe.service.ts ← kept
                               but unused

src/common/
  types/business-profile.dto.ts
  types/pipeline.types.ts ← remove
                             systemPrompt field
  types/reply.dto.ts ← keep as
                        job payload type
  utils/ (all)

ADDED
─────────────────────────────────
src/worker/
  worker.module.ts
  ai-reply.worker.ts
src/common/clients/
  main-backend.client.ts
src/common/types/
  turn-log.types.ts
```

---

## Implementation Order

```
Phase 0  →  remove database (nothing else works until Prisma is gone)
Phase 1  →  remove HTTP endpoints and dead controllers
Phase 2  →  add BullMQ Worker (new entry point)
Phase 3  →  update profile service to read from Redis
Phase 4  →  update reply service: remove DB writes, return turnLog in result
Phase 5  →  clean up ContextLoaderService (remove dead systemPrompt)
Phase 6  →  update AppModule imports
Phase 7  →  update env files and docker-compose
Phase 8  →  fix LLMClientService injection (pre-existing bug)
Phase 9  →  tests
Phase 10 →  full cleanup audit (run through 10.A–10.I checklist)
```
