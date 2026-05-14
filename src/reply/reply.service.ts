import { Injectable, Logger } from '@nestjs/common';
import { ContextLoaderService } from './context-loader.service';
import { HoursService } from '../pipeline/hours.service';
import { PipelineOrchestratorService } from '../pipeline/orchestrator.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { parseAgentOutput } from '../common/utils/parser';
import { highCount } from '../common/utils/pipeline/severity';
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
  ReplyResponse,
  ReplyResponseEscalate,
  ReplyResponseOutsideHours,
  ReplyResponseReplied,
} from '../common/types/reply.dto';

export interface ReplyTokenChunk {
  type: 'token';
  text: string;
  attempt: number;
}

export interface ReplyDoneChunk {
  type: 'done';
  response: ReplyResponse;
}

export type ReplyStreamChunk = ReplyTokenChunk | ReplyDoneChunk;

@Injectable()
export class ReplyService {
  private readonly logger = new Logger(ReplyService.name);

  constructor(
    private readonly contextLoader: ContextLoaderService,
    private readonly hours: HoursService,
    private readonly orchestrator: PipelineOrchestratorService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Non-streaming entry point — `POST /ai/v1/reply`. */
  async handle(req: ReplyRequestDto): Promise<ReplyResponse> {
    const start = Date.now();
    const ctx = await this.contextLoader.load({
      business_id: req.business_id,
      history: req.history,
      contact_id: req.contact_id,
      channel: req.channel,
      trace_id: req.options?.trace_id,
    });

    if (!this.hours.isWithinHours(ctx.profile)) {
      const response: ReplyResponseOutsideHours = {
        status: 'outside_hours',
        reply: this.hours.holidayMessage(ctx.profile),
        metadata: {
          latency_ms: Date.now() - start,
          trace_id: req.options?.trace_id,
        },
      };
      await this.logOutsideHours(req, ctx, response);
      return response;
    }

    const collected = await this.runPipeline(req, ctx);
    return this.buildResponse(req, ctx, collected, start);
  }

  /** Streaming entry point — `POST /ai/v1/reply/stream`. Yields token chunks then a done chunk. */
  async *stream(req: ReplyRequestDto): AsyncGenerator<ReplyStreamChunk> {
    const start = Date.now();
    const ctx = await this.contextLoader.load({
      business_id: req.business_id,
      history: req.history,
      contact_id: req.contact_id,
      channel: req.channel,
      trace_id: req.options?.trace_id,
    });

    if (!this.hours.isWithinHours(ctx.profile)) {
      const response: ReplyResponseOutsideHours = {
        status: 'outside_hours',
        reply: this.hours.holidayMessage(ctx.profile),
        metadata: { latency_ms: Date.now() - start, trace_id: req.options?.trace_id },
      };
      await this.logOutsideHours(req, ctx, response);
      yield { type: 'done', response };
      return;
    }

    const collected: CollectedTurn = { tokens: [] };
    for await (const ev of this.orchestrator.streamTurn(this.buildOrchestratorInput(req, ctx))) {
      this.absorbEvent(ev, collected);
      if (ev.event === 'token') {
        const data = ev.data as { content?: string; attempt?: number };
        if (data?.content) {
          yield { type: 'token', text: data.content, attempt: data.attempt ?? 0 };
        }
      }
    }

    const response = await this.buildResponse(req, ctx, collected, start);
    yield { type: 'done', response };
  }

  // ───────── internals ─────────

  private buildOrchestratorInput(req: ReplyRequestDto, ctx: ContextPacket) {
    return {
      ctx,
      message: req.message.content,
      customerContext: {},
      priorAssistantLang: inferPriorAssistantLang(ctx.history),
      priorAgentQuestion: inferPriorAgentQuestion(ctx.history),
      stalledCountIncoming: 0,
    };
  }

  private async runPipeline(req: ReplyRequestDto, ctx: ContextPacket): Promise<CollectedTurn> {
    const collected: CollectedTurn = { tokens: [] };
    for await (const ev of this.orchestrator.streamTurn(this.buildOrchestratorInput(req, ctx))) {
      this.absorbEvent(ev, collected);
    }
    return collected;
  }

  private absorbEvent(ev: PipelineEvent, c: CollectedTurn): void {
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
      case 'token':
        c.tokens.push((ev.data as { content?: string })?.content ?? '');
        break;
      default:
        break;
    }
  }

  private async buildResponse(
    req: ReplyRequestDto,
    ctx: ContextPacket,
    c: CollectedTurn,
    start: number,
  ): Promise<ReplyResponse> {
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
      await this.logTurn(req, ctx, c, response, latency_ms);
      return response;
    }

    // Validator-exhausted: orchestrator shipped a least-bad candidate but flagged ship_with_violations.
    if (done?.outcome === 'ship_with_violations' && !validatorPass) {
      const handoff = ctx.profile.escalation?.handoff_message ?? parsed.reply ?? '';
      const response: ReplyResponseEscalate = {
        status: 'escalate',
        reason: 'validator_exhausted',
        suggested_handoff_message: handoff,
        metadata: {
          triage: triageSummary,
          attempts: done.attempts.length,
          validator_pass: false,
          last_violations: lastViolations,
          latency_ms,
          trace_id: req.options?.trace_id,
        },
      };
      await this.logTurn(req, ctx, c, response, latency_ms);
      return response;
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
    await this.logTurn(req, ctx, c, response, latency_ms);
    return response;
  }

  private async logTurn(
    req: ReplyRequestDto,
    ctx: ContextPacket,
    c: CollectedTurn,
    response: ReplyResponse,
    latency_ms: number,
  ): Promise<void> {
    try {
      const done = c.done;
      const triage = c.triage ?? done?.triage ?? null;
      const lastAttempt = done?.attempts?.[done.attempts.length - 1];
      const violations = lastAttempt?.verdict?.violations ?? [];

      await this.prisma.turnLog.create({
        data: {
          business_id: req.business_id,
          conversation_id: req.conversation_id,
          contact_id: req.contact_id,
          channel: req.channel,
          status: response.status,
          triage: (triage ?? {}) as object,
          attempts: (done?.attempts ?? []) as unknown as object,
          validator_pass: lastAttempt?.verdict?.pass === true,
          retry_count: Math.max(0, (done?.attempts?.length ?? 1) - 1),
          high_severity_violations: highCount(violations),
          intent_path: triage?.intent_path ?? null,
          language: triage?.language?.detected ?? null,
          shipped: done?.shipped ?? '',
          duration_ms: latency_ms,
          trace_id: req.options?.trace_id ?? null,
          model_triage: this.config.triageModel(),
          model_generator: this.config.generatorModel(),
          model_validator: this.config.validatorModel(),
        },
      });
    } catch (e) {
      this.logger.error(`TurnLog write failed: ${(e as Error).message}`);
    }
    void ctx;
  }

  private async logOutsideHours(
    req: ReplyRequestDto,
    ctx: ContextPacket,
    response: ReplyResponseOutsideHours,
  ): Promise<void> {
    try {
      await this.prisma.turnLog.create({
        data: {
          business_id: req.business_id,
          conversation_id: req.conversation_id,
          contact_id: req.contact_id,
          channel: req.channel,
          status: 'outside_hours',
          triage: {} as object,
          attempts: [] as unknown as object,
          validator_pass: false,
          retry_count: 0,
          high_severity_violations: 0,
          intent_path: null,
          language: null,
          shipped: response.reply,
          duration_ms: response.metadata.latency_ms,
          trace_id: req.options?.trace_id ?? null,
        },
      });
    } catch (e) {
      this.logger.error(`TurnLog (outside_hours) write failed: ${(e as Error).message}`);
    }
    void ctx;
  }
}

interface CollectedTurn {
  triage?: Triage;
  done?: DoneInternalData;
  escalation?: { reason?: string; matched_trigger?: string };
  tokens: string[];
}

function inferPriorAssistantLang(history: IncomingHistoryMessage[]): LanguageCode | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role !== 'assistant') continue;
    const md = t.metadata;
    const lang = md?.['suggested_reply_language'];
    if (lang === 'en' || lang === 'romanized_ne' || lang === 'mixed') return lang;
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

function mapEscalationReason(raw: string): ReplyResponseEscalate['reason'] {
  if (raw === 'triage_handoff' || raw === 'keyword_match' || raw === 'validator_exhausted') return raw;
  return 'unknown';
}
