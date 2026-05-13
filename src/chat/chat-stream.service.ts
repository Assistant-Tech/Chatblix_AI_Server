import { Injectable, Logger } from '@nestjs/common';
import { HistoryService } from '../history/history.service';
import { LeadService } from '../history/lead.service';
import { PipelineOrchestratorService } from '../pipeline/orchestrator.service';
import { AppConfigService } from '../config/app-config.service';
import { extractContactInfo } from '../common/utils/extractors';
import { computeMomentum } from '../common/utils/momentum';
import { parseAgentOutput } from '../common/utils/parser';
import {
  derivePriorAssistantLang,
  derivePriorAgentQuestion,
  readStalledCount,
  stripBookkeeping,
} from '../common/utils/pipeline/prior-state';
import type {
  AgentMetadata,
  HistoryMessage,
  LanguageCode,
  PipelineEvent,
  Triage,
  DoneInternalData,
} from '../common/types/pipeline.types';
import type { ChatStreamRequestDto } from '../common/types/chat.dto';
import type { Lead } from '@prisma/client';

const PERSISTENT_KEYS: Array<keyof AgentMetadata> = [
  'lead_score',
  'score_delta',
  'stage',
  'intent',
  'next_step',
  'next_action',
  'suggested_reply_language',
  'handoff_required',
  'handoff_context',
  'tags',
  'extracted_data',
  'last_signal',
];

function diffMetadata(prev: AgentMetadata, next: AgentMetadata): Partial<AgentMetadata> {
  const delta: Partial<AgentMetadata> = {};
  for (const key of PERSISTENT_KEYS) {
    if (!(key in next)) continue;
    const a = prev[key];
    const b = next[key];
    if (key === 'extracted_data' || key === 'tags') {
      if (JSON.stringify(a) !== JSON.stringify(b)) (delta as Record<string, unknown>)[key] = b;
    } else if (a !== b) {
      (delta as Record<string, unknown>)[key] = b;
    }
  }
  return delta;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function replyIsNearIdentical(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  const aTok = norm(a);
  const bTok = norm(b);
  if (aTok.length === 0 || bTok.length === 0) return false;
  const bSet = new Set(bTok);
  const overlap = aTok.filter((t) => bSet.has(t)).length;
  const ratio = overlap / Math.max(aTok.length, bTok.length);
  return ratio >= 0.85;
}

@Injectable()
export class ChatStreamService {
  private readonly logger = new Logger(ChatStreamService.name);

  constructor(
    private readonly history: HistoryService,
    private readonly leads: LeadService,
    private readonly orchestrator: PipelineOrchestratorService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Async generator that yields every SSE event the client should see.
   * Swallows `_done_internal` from the orchestrator, runs finalization
   * (parse + repeat-reply guard + bookkeeping + persistence + final momentum),
   * and yields the synthetic terminal `done` event.
   */
  async *runStream(body: ChatStreamRequestDto): AsyncGenerator<PipelineEvent> {
    const { session_id, message } = body;

    // --- Pre-flight DB writes ---
    let priorLead: Lead;
    let history: HistoryMessage[];
    try {
      priorLead = await withTimeout(this.leads.getOrCreateLead(session_id), 5000, 'getOrCreateLead');
      await withTimeout(this.history.saveMessage(session_id, 'user', message), 5000, 'saveMessage');
      const dbHistory = await withTimeout(this.history.getRecentMessages(session_id, 10), 5000, 'getRecentMessages');
      history = dbHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        metadata: m.metadata as Record<string, unknown> | null,
        timestamp: m.timestamp,
      }));
    } catch (e) {
      yield { event: 'error', data: { error: (e as Error).message || 'DB unavailable' } };
      return;
    }

    const priorExtracted = ((): Record<string, unknown> => {
      const raw = priorLead.extracted_data;
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return {};
        }
      }
      return (raw as Record<string, unknown>) || {};
    })();

    // --- Deterministic contact + seed momentum ---
    const contact = extractContactInfo(message);
    const seedExtracted = { ...priorExtracted, ...contact };

    const seedMomentum = computeMomentum({
      history,
      userMessage: message,
      extractedData: seedExtracted,
      priorExtractedData: priorExtracted,
      priorLead,
    });

    const seedDelta: AgentMetadata = {
      lead_score: seedMomentum.lead_score,
      score_delta: seedMomentum.score_delta,
      stage: seedMomentum.stage,
      intent: seedMomentum.intent,
      next_step: seedMomentum.next_action,
      next_action: seedMomentum.next_action,
      tags: seedMomentum.tags,
      handoff_required: seedMomentum.handoff_required,
      last_signal: seedMomentum.last_signal,
    };
    if (Object.keys(contact).length > 0) seedDelta.extracted_data = { ...contact };
    if (seedMomentum.timeline) {
      seedDelta.extracted_data = { ...(seedDelta.extracted_data || {}), timeline: seedMomentum.timeline };
    }

    yield { event: 'metadata', data: seedDelta };
    const lastMetadata: AgentMetadata = { ...seedDelta };

    // --- Pipeline path ---
    const persistedLang = (priorExtracted._last_agent_lang as LanguageCode | undefined) || null;
    const persistedQuestion = (priorExtracted._last_agent_question as string | undefined) || null;
    const stalledCountIncoming = readStalledCount(priorExtracted);
    const priorAssistantLang = persistedLang || derivePriorAssistantLang(history);
    const priorAgentQuestion = persistedQuestion || derivePriorAgentQuestion(history);
    const cleanContext = stripBookkeeping(seedExtracted);

    let raw: string | null = null;
    let triage: Triage | null = null;
    let emittedReplyLen = 0;

    try {
      for await (const evt of this.orchestrator.streamTurn({
        message,
        history,
        customerContext: cleanContext,
        priorAssistantLang,
        priorAgentQuestion,
        stalledCountIncoming,
        kbFile: body.kb_file || this.config.kbFile(),
        sessionId: session_id,
      })) {
        switch (evt.event) {
          case 'triage':
            triage = evt.data as Triage;
            yield evt;
            break;
          case 'token': {
            const data = evt.data as { content?: string };
            emittedReplyLen += data.content?.length || 0;
            yield { event: 'token', data: { content: data.content } };
            break;
          }
          case 'regenerate':
            emittedReplyLen = 0;
            yield evt;
            break;
          case 'verdict':
            yield evt;
            break;
          case '_done_internal':
            raw = (evt.data as DoneInternalData).shipped;
            break;
          default:
            yield evt;
        }
      }
    } catch (e) {
      this.logger.error(`pipeline error: ${(e as Error).message}`);
      yield { event: 'error', data: { error: (e as Error).message || 'pipeline failed' } };
      return;
    }

    if (!raw) {
      yield { event: 'error', data: { error: 'Pipeline produced no output' } };
      return;
    }

    let { reply, metadata } = parseAgentOutput(raw, message);

    // --- Repeat-reply guard ---
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant && replyIsNearIdentical(reply, lastAssistant.content)) {
      const lang =
        (metadata.suggested_reply_language as LanguageCode | undefined) ||
        triage?.language?.detected ||
        (priorExtracted._last_agent_lang as LanguageCode | undefined) ||
        'romanized_ne';
      reply =
        lang === 'en'
          ? 'One moment, a colleague will pick this up shortly.'
          : 'Hajur, ek minute ma colleague le respond garchha. Patience ko lagi dhanyabad.';
      metadata.handoff_required = true;
      metadata.handoff_context = 'Parser fallback fired twice in a row; conversation stuck. Manual takeover.';
      metadata.next_step = 'escalate';
      metadata.tags = Array.from(new Set([...(metadata.tags || []), 'fallback_repeat', 'handoff']));
    }

    // --- Persist bookkeeping ---
    metadata.extracted_data = metadata.extracted_data || {};
    const bookkeeping = metadata.extracted_data as Record<string, unknown>;
    if (triage?.stalled_count !== undefined) {
      bookkeeping._stalled_count = triage.stalled_count;
    }
    bookkeeping._last_agent_lang =
      metadata.suggested_reply_language || triage?.language?.detected || 'romanized_ne';
    const lastQ = (reply.match(/[^?.!]*\?[^?.!]*$/) || [])[0];
    if (lastQ) bookkeeping._last_agent_question = lastQ.trim();

    yield* this.persistAndYieldDone({
      session_id,
      message,
      history,
      priorExtracted,
      contact: contact as Record<string, unknown>,
      reply,
      metadata,
      raw,
      lastMetadata,
      emittedReplyLen,
    });
  }

  /**
   * Drains runStream() into a single JSON payload — the non-streaming API.
   */
  async runOnce(body: ChatStreamRequestDto): Promise<{ raw: string; reply: string; metadata: AgentMetadata }> {
    let reply = '';
    let metadata: AgentMetadata = {};
    let raw = '';
    for await (const evt of this.runStream(body)) {
      if (evt.event === 'done') {
        const data = evt.data as { reply: string; metadata: AgentMetadata; raw: string };
        reply = data.reply;
        metadata = data.metadata;
        raw = data.raw;
      } else if (evt.event === 'error') {
        const data = evt.data as { error: string };
        throw new Error(data.error);
      }
    }
    return { raw, reply, metadata };
  }

  private async *persistAndYieldDone(args: {
    session_id: string;
    message: string;
    history: HistoryMessage[];
    priorExtracted: Record<string, unknown>;
    contact: Record<string, unknown>;
    reply: string;
    metadata: AgentMetadata;
    raw: string;
    lastMetadata: AgentMetadata;
    emittedReplyLen: number;
  }): AsyncGenerator<PipelineEvent> {
    const { session_id, message, history, priorExtracted, contact, reply, raw, lastMetadata, emittedReplyLen } = args;
    const metadata = args.metadata;

    const mergedExtracted: Record<string, unknown> = {
      ...priorExtracted,
      ...(metadata.extracted_data || {}),
      ...contact,
    };
    for (const k of Object.keys(mergedExtracted)) {
      const v = mergedExtracted[k];
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
        if (priorExtracted[k] !== undefined && priorExtracted[k] !== null && priorExtracted[k] !== '') {
          mergedExtracted[k] = priorExtracted[k];
        } else {
          delete mergedExtracted[k];
        }
      }
    }

    const finalMomentum = computeMomentum({
      history,
      userMessage: message,
      extractedData: mergedExtracted,
      priorExtractedData: priorExtracted,
      priorLead: {},
      llmIntent: metadata.intent,
    });

    metadata.extracted_data = mergedExtracted;
    metadata.lead_score = finalMomentum.lead_score;
    metadata.score_delta = finalMomentum.score_delta;
    metadata.stage = finalMomentum.stage;
    metadata.intent = finalMomentum.intent;
    metadata.next_step = finalMomentum.next_action;
    metadata.next_action = finalMomentum.next_action;
    metadata.tags = Array.from(new Set([...(metadata.tags || []), ...finalMomentum.tags]));
    metadata.handoff_required = Boolean(metadata.handoff_required) || finalMomentum.handoff_required;
    metadata.last_signal = finalMomentum.last_signal;
    if (finalMomentum.timeline) {
      (metadata.extracted_data as Record<string, unknown>).timeline = finalMomentum.timeline;
    }

    const finalDelta = diffMetadata(lastMetadata, metadata);
    if (Object.keys(finalDelta).length > 0) {
      yield { event: 'metadata', data: finalDelta };
    }

    if (reply && reply.length > emittedReplyLen) {
      yield { event: 'token', data: { content: reply.slice(emittedReplyLen) } };
    }

    await this.history.saveMessage(session_id, 'assistant', reply, metadata as Record<string, unknown>);

    let persistentLead: Lead | null = null;
    if (metadata) {
      persistentLead = (await this.leads.updateLeadState(session_id, metadata)) || null;
    }
    if (!persistentLead) {
      persistentLead = await this.leads.getOrCreateLead(session_id);
    }

    const persistedExtracted =
      typeof persistentLead.extracted_data === 'string'
        ? (JSON.parse(persistentLead.extracted_data) as Record<string, unknown>)
        : ((persistentLead.extracted_data as Record<string, unknown>) || {});
    const uiExtracted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(persistedExtracted)) {
      if (!k.startsWith('_')) uiExtracted[k] = v;
    }

    const finalMetadata: AgentMetadata = {
      ...metadata,
      lead_score: persistentLead.lead_score,
      stage: persistentLead.stage,
      intent: persistentLead.last_intent || metadata.intent,
      extracted_data: uiExtracted,
    };

    yield { event: 'done', data: { reply, metadata: finalMetadata, raw } };
  }
}
