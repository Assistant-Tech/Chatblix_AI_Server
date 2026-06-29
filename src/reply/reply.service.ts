import { Injectable, Logger } from '@nestjs/common';
import { ContextLoaderService } from './context-loader.service';
import { RedisClient } from '../cache/redis.client';
import { HoursService } from '../pipeline/hours.service';
import { PipelineOrchestratorService } from '../pipeline/orchestrator.service';
import { AppConfigService } from '../config/app-config.service';
import { parseAgentOutput } from '../common/utils/parser';
import { highCount } from '../common/utils/pipeline/severity';
import type { AiReplyJobResult, AiTurnLogData } from '../common/types/turn-log.types';
import type {
  ContextPacket,
  DoneInternalData,
  IncomingHistoryMessage,
  LanguageCode,
  PipelineEvent,
  Triage,
} from '../common/types/pipeline.types';
import type {
  ReplyRequestDto,
  ReplyResponseEscalate,
  ReplyResponseOutsideHours,
  ReplyResponseReplied,
} from '../common/types/reply.dto';

@Injectable()
export class ReplyService {
  private readonly logger = new Logger(ReplyService.name);

  constructor(
    private readonly contextLoader: ContextLoaderService,
    private readonly hours: HoursService,
    private readonly orchestrator: PipelineOrchestratorService,
    private readonly config: AppConfigService,
    private readonly redis: RedisClient,
  ) {}

  /**
   * Main entry point — called by AiReplyWorker for each BullMQ job.
   * Returns the reply response AND the TurnLog data for main-backend to persist.
   */
  async handle(req: ReplyRequestDto): Promise<AiReplyJobResult> {
    const start = Date.now();

    try {
      const ctx = await this.contextLoader.load({
        business_id: req.business_id,
        history: req.history,
        contact_id: req.contact_id,
        conversation_id: req.conversation_id,
        channel: req.channel,
        trace_id: req.options?.trace_id,
        existing_order: req.existing_order,
      });

      if (!this.hours.isWithinHours(ctx.profile)) {
        const latency_ms = Date.now() - start;
        const response: ReplyResponseOutsideHours = {
          status: 'outside_hours',
          reply: this.hours.holidayMessage(ctx.profile),
          metadata: {
            latency_ms,
            trace_id: req.options?.trace_id,
          },
        };
        return {
          response,
          turnLog: buildOutsideHoursTurnLog(response, latency_ms, req.options?.trace_id),
        };
      }

      const stalledCountIncoming = await this.readStalledCount(req.conversation_id);
      const collected = await this.runPipeline(req, ctx, stalledCountIncoming);
      await this.persistStalledCount(req.conversation_id, collected);
      return this.buildResult(req, ctx, collected, start);
    } catch (e) {
      const err = e as Error;
      this.logger.error(
        `handle failed business_id=${req.business_id} conversation_id=${req.conversation_id} trace_id=${req.options?.trace_id ?? '-'}: ${err.message}`,
        err.stack,
      );
      throw e;
    }
  }

  // ───────── internals ─────────

  private buildOrchestratorInput(req: ReplyRequestDto, ctx: ContextPacket, stalledCountIncoming: number) {
    return {
      ctx,
      message: req.message.content,
      customerContext: buildCustomerContext(ctx.history),
      priorAssistantLang: inferPriorAssistantLang(ctx.history),
      priorAgentQuestion: inferPriorAgentQuestion(ctx.history),
      stalledCountIncoming,
    };
  }

  // ─── Stalled-count persistence ──────────────────────────────────────────────
  // The triage rule escalates after 2 consecutive non-progressing replies on the
  // same ask. That only works if the prior turn's stalled_count is fed back in.
  // History can't carry it (bot messages persist no metadata), so we keep a small
  // per-conversation counter in Redis: read it before triage, write triage's new
  // stalled_count after the turn. Missing conversation_id or Redis errors degrade
  // safely to 0 (never a false escalation).
  private stalledKey(conversationId?: string): string | null {
    return conversationId ? `stalled:${conversationId}` : null;
  }

  private async readStalledCount(conversationId?: string): Promise<number> {
    const key = this.stalledKey(conversationId);
    if (!key) return 0;
    try {
      const raw = await this.redis.raw().get(key);
      const n = raw ? Number.parseInt(raw, 10) : 0;
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private async persistStalledCount(conversationId: string | undefined, c: CollectedTurn): Promise<void> {
    const key = this.stalledKey(conversationId);
    if (!key) return;
    const triage = c.triage ?? c.done?.triage;
    const count = typeof triage?.stalled_count === 'number' ? triage.stalled_count : 0;
    try {
      await this.redis.raw().set(key, String(count), 'EX', 3600);
    } catch {
      // non-fatal — worst case the next turn starts from 0
    }
  }

  private async runPipeline(
    req: ReplyRequestDto,
    ctx: ContextPacket,
    stalledCountIncoming: number,
  ): Promise<CollectedTurn> {
    const collected: CollectedTurn = {};
    for await (const ev of this.orchestrator.streamTurn(
      this.buildOrchestratorInput(req, ctx, stalledCountIncoming),
    )) {
      absorbEvent(ev, collected);
    }
    return collected;
  }

  private buildResult(
    req: ReplyRequestDto,
    ctx: ContextPacket,
    c: CollectedTurn,
    start: number,
  ): AiReplyJobResult {
    const done = c.done;
    const triage = c.triage ?? done?.triage;
    const shipped = done?.shipped ?? '';
    const parsed = parseAgentOutput(shipped, req.message.content);
    const latency_ms = Date.now() - start;

    const triageSummary = triage
      ? {
          intent: triage.intent_path ?? 'unknown',
          sentiment: typeof triage['sentiment'] === 'string' ? (triage['sentiment'] as string) : undefined,
          language: triage.language?.detected ?? 'en',
        }
      : undefined;

    const lastAttempt = done?.attempts?.[done.attempts.length - 1];
    const validatorPass = lastAttempt?.verdict?.pass === true;
    const lastViolations = lastAttempt?.verdict?.violations?.map((v) => v.rule_name) ?? [];
    const violations = lastAttempt?.verdict?.violations ?? [];

    // metadata_valid is the order/lead-data trustworthiness signal — independent
    // of reply-text rules. Defaults to true when no verdict (nothing to invalidate).
    const metadataValid = lastAttempt?.verdict?.metadata_valid !== false;

    const baseTurnLog: Omit<AiTurnLogData, 'status'> = {
      triage: (triage ?? {}) as object,
      attempts: (done?.attempts ?? []) as unknown as object,
      validatorPass,
      metadataValid,
      retryCount: Math.max(0, (done?.attempts?.length ?? 1) - 1),
      highSeverityViolations: highCount(violations),
      intentPath: triage?.intent_path ?? null,
      language: triage?.language?.detected ?? null,
      toolsCalled: done?.tools_called ?? [],
      shipped: done?.shipped ?? '',
      tokensIn: done?.tokensIn ?? null,
      cachedIn: done?.cachedIn ?? null,
      tokensInBilled: done?.tokensInBilled ?? null,
      tokensOut: done?.tokensOut ?? null,
      durationMs: latency_ms,
      traceId: req.options?.trace_id ?? null,
      modelTriage: this.config.triageModel(),
      modelGenerator: this.config.generatorModel(),
      modelValidator: this.config.validatorModel(),
    };

    if (done?.outcome === 'escalate' || c.escalation) {
      const reasonRaw = c.escalation?.reason ?? done?.escalated?.reason ?? 'unknown';
      const reason = mapEscalationReason(reasonRaw);
      const handoff = ctx.profile.escalation?.handoff_message ?? parsed.reply ?? '';
      const response: ReplyResponseEscalate = {
        status: 'escalate',
        reason,
        suggested_handoff_message: handoff,
        metadata: {
          triage: triageSummary,
          attempts: done?.attempts?.length ?? 0,
          validator_pass: validatorPass,
          last_violations: lastViolations,
          latency_ms,
          trace_id: req.options?.trace_id,
        },
      };
      return { response, turnLog: { ...baseTurnLog, status: 'escalate' } };
    }

    // ship_with_violations: validator exhausted retries but the orchestrator
    // already picked the best attempt via pickBest(). Ship it — the parsed
    // reply text is clean even if the raw candidate had format violations.
    // Only true semantic escalations (triage_handoff, keyword_match) should
    // pause the conversation; validator format failures should not.
    if (done?.outcome === 'ship_with_violations') {
      const response: ReplyResponseReplied = {
        status: 'replied',
        reply: parsed.reply,
        metadata: {
          triage: triageSummary,
          attempts: done.attempts.length,
          validator_pass: false,
          last_violations: lastViolations,
          latency_ms,
          trace_id: req.options?.trace_id,
        },
      };
      return { response, turnLog: { ...baseTurnLog, status: 'replied' } };
    }

    const response: ReplyResponseReplied = {
      status: 'replied',
      reply: parsed.reply,
      metadata: {
        triage: triageSummary,
        attempts: done?.attempts?.length ?? 0,
        validator_pass: validatorPass,
        model_used: this.config.generatorModel(),
        latency_ms,
        trace_id: req.options?.trace_id,
      },
    };
    return { response, turnLog: { ...baseTurnLog, status: 'replied' } };
  }
}

// ───────── module-level helpers ─────────

interface CollectedTurn {
  triage?: Triage;
  done?: DoneInternalData;
  escalation?: { reason?: string; matched_trigger?: string };
}

function absorbEvent(ev: PipelineEvent, c: CollectedTurn): void {
  switch (ev.event) {
    case 'triage':
      c.triage = ev.data as Triage;
      break;
    case 'escalate':
      c.escalation = ev.data as { reason?: string; matched_trigger?: string };
      break;
    case '_done_internal':
      c.done = ev.data as DoneInternalData;
      break;
    default:
      break;
  }
}

function buildOutsideHoursTurnLog(
  response: ReplyResponseOutsideHours,
  latency_ms: number,
  traceId?: string,
): AiTurnLogData {
  return {
    status: 'outside_hours',
    triage: {},
    attempts: [],
    validatorPass: false,
    metadataValid: true,
    retryCount: 0,
    highSeverityViolations: 0,
    intentPath: null,
    language: null,
    toolsCalled: [],
    shipped: response.reply,
    tokensIn: null,
    cachedIn: null,
    tokensInBilled: null,
    tokensOut: null,
    durationMs: latency_ms,
    traceId: traceId ?? null,
    modelTriage: null,
    modelGenerator: null,
    modelValidator: null,
  };
}

function inferPriorAssistantLang(history: IncomingHistoryMessage[]): LanguageCode | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role !== 'assistant') continue;
    const lang = t.metadata?.['suggested_reply_language'];
    if (lang === 'en' || lang === 'romanized_ne' || lang === 'mixed') return lang as LanguageCode;
  }
  return null;
}

function inferPriorAgentQuestion(history: IncomingHistoryMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role !== 'assistant') continue;
    if (t.content?.trim().endsWith('?')) return t.content.trim();
    return null;
  }
  return null;
}


/**
 * Merge extracted_data from all prior assistant turns into a single object.
 * Later turns overwrite earlier ones for the same key, so the most recent
 * captured value wins. Empty / null values are skipped so they don't erase
 * previously captured data.
 */
function buildCustomerContext(history: IncomingHistoryMessage[]): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    const extracted = msg.metadata?.['extracted_data'] as Record<string, unknown> | undefined;
    if (!extracted) continue;
    for (const [key, value] of Object.entries(extracted)) {
      if (value !== null && value !== undefined && value !== '') {
        ctx[key] = value;
      }
    }
  }
  return ctx;
}

function mapEscalationReason(raw: string): ReplyResponseEscalate['reason'] {
  if (raw === 'triage_handoff' || raw === 'keyword_match' || raw === 'validator_exhausted') return raw;
  return 'unknown';
}
