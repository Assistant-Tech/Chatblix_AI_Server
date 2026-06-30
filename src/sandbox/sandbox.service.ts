import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { PipelineOrchestratorService } from '../pipeline/orchestrator.service';
import { SystemPromptCompilerService } from '../business/system-prompt-compiler.service';
import { parseAgentOutput } from '../common/utils/parser';
import type {
  ContextPacket,
  DoneInternalData,
  IncomingHistoryMessage,
  LanguageCode,
} from '../common/types/pipeline.types';
import type { SandboxRequestDto } from './sandbox-request.dto';

@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);

  constructor(
    private readonly orchestrator: PipelineOrchestratorService,
    private readonly compiler: SystemPromptCompilerService,
    private readonly config: AppConfigService,
  ) {}

  async stream(dto: SandboxRequestDto, res: Response): Promise<void> {
    const start = Date.now();

    // Business hours are informational only (surfaced via the system prompt so the
    // AI can mention them); they do NOT gate replies. The assistant answers 24/7,
    // matching the live reply path.
    sse(res, 'status', { type: 'thinking' });

    const ctx = this.buildContext(dto);
    const input = {
      ctx,
      message: dto.message.content,
      customerContext: buildCustomerContext(ctx.history),
      priorAssistantLang: inferPriorAssistantLang(ctx.history),
      priorAgentQuestion: inferPriorAgentQuestion(ctx.history),
      stalledCountIncoming: 0,
    };

    let typingEmitted = false;
    let escalationReason: string | undefined;
    let done: DoneInternalData | undefined;

    try {
      for await (const ev of this.orchestrator.streamTurn(input)) {
        switch (ev.event) {
          case 'token': {
            if (!typingEmitted) {
              sse(res, 'status', { type: 'typing' });
              typingEmitted = true;
            }
            sse(res, 'token', ev.data);
            break;
          }
          case 'regenerate': {
            typingEmitted = false;
            sse(res, 'regenerate', ev.data);
            break;
          }
          case 'escalate': {
            const d = ev.data as { reason?: string };
            escalationReason = d.reason;
            break;
          }
          case '_done_internal': {
            done = ev.data as DoneInternalData;
            break;
          }
          // triage, verdict — absorbed
        }
      }
    } catch (e) {
      const err = e as Error;
      this.logger.error(`sandbox stream failed: ${err.message}`, err.stack);
      sse(res, 'error', { message: 'AI service error during generation.' });
      res.end();
      return;
    }

    const latency_ms = Date.now() - start;
    const isEscalate = escalationReason || done?.outcome === 'escalate';

    if (isEscalate) {
      sse(res, 'done', {
        status: 'escalate',
        reason: escalationReason ?? done?.escalated?.reason ?? 'unknown',
        handoff_message: dto.profile.escalation?.handoff_message ?? '',
        latency_ms,
      });
    } else {
      const parsed = parseAgentOutput(done?.shipped ?? '', dto.message.content);
      sse(res, 'done', { status: 'replied', reply: parsed.reply, latency_ms });
    }

    res.end();
  }

  private buildContext(dto: SandboxRequestDto): ContextPacket {
    const history: IncomingHistoryMessage[] = (dto.history ?? []).map((h) => ({
      role: h.role,
      content: h.content,
      timestamp: h.timestamp,
    }));

    return {
      business_id: 'sandbox',
      profile: dto.profile,
      systemPrompt: this.compiler.compile(dto.profile),
      history: trimHistory(history, this.config.maxHistoryTurns()),
      contact_id: 'sandbox',
      channel: 'sandbox',
      trace_id: dto.trace_id,
    };
  }
}

// ───────── SSE helper ─────────

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ───────── History helpers (mirrors reply.service.ts) ─────────

function trimHistory(history: IncomingHistoryMessage[], maxTurns: number): IncomingHistoryMessage[] {
  if (!Array.isArray(history) || history.length <= maxTurns) return history ?? [];
  return history.slice(history.length - maxTurns);
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
