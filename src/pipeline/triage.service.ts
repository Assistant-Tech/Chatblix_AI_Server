import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LLMClientService } from './llm-client.service';
import { PromptsService } from './prompts.service';
import { MetricsService } from './metrics.service';
import { extractJsonObject, isTriageShape } from '../common/utils/pipeline/contracts';
import { synthesizeFallbackTriage } from '../common/utils/pipeline/triage-fallback';
import { slimProfileForContext } from './profile-context';
import type { ChatJsonUsage } from './openrouter.client';
import type {
  ContextPacket,
  LanguageCode,
  Triage,
} from '../common/types/pipeline.types';

export interface TriageCallResult {
  triage: Triage;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface CallTriageInput {
  ctx: ContextPacket;
  message: string;
  priorAssistantLang: LanguageCode | null;
  priorAgentQuestion: string | null;
  stalledCountIncoming: number;
  customerContext: Record<string, unknown>;
}

@Injectable()
export class TriageService {
  private readonly logger = new Logger(TriageService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly llmClient: LLMClientService,
    private readonly prompts: PromptsService,
    private readonly metrics: MetricsService,
  ) {}

  private buildUserPayload(input: CallTriageInput): string {
    const { ctx, message, customerContext, priorAssistantLang, priorAgentQuestion, stalledCountIncoming } = input;
    return [
      `LATEST_MESSAGE: ${message}`,
      `CONVERSATION_HISTORY: ${JSON.stringify(ctx.history || [])}`,
      `CUSTOMER_CONTEXT: ${JSON.stringify(customerContext || {})}`,
      `BUSINESS_CONTEXT: ${JSON.stringify(slimProfileForContext(ctx.profile))}`,
      `PRIOR_ASSISTANT_LANGUAGE: ${priorAssistantLang || 'null'}`,
      `PRIOR_AGENT_QUESTION: ${priorAgentQuestion ? JSON.stringify(priorAgentQuestion) : 'null'}`,
      `STALLED_COUNT_INCOMING: ${stalledCountIncoming || 0}`,
    ].join('\n\n');
  }

  private async repairJson(rawText: string, model: string, business_id: string): Promise<unknown> {
    try {
      const repaired = await this.llmClient.chatJson(
        {
          model,
          system: 'You repair malformed JSON. Output ONLY valid JSON, no prose, no fences.',
          user: `The following was supposed to be valid JSON. Return ONLY corrected JSON, nothing else:\n\n${rawText}`,
          temperature: 0.0,
          maxTokens: 700,
          timeoutMs: this.config.triageTimeoutMs(),
        },
        { stage: 'triage', business_id },
      );
      return extractJsonObject(repaired.text);
    } catch (e) {
      this.logger.warn(`triage JSON repair failed business_id=${business_id}: ${(e as Error).message}`);
      return null;
    }
  }

  async callTriage(input: CallTriageInput): Promise<TriageCallResult> {
    const model = this.config.triageModel();
    const { ctx, priorAssistantLang, stalledCountIncoming } = input;

    let system: string;
    try {
      system = await this.prompts.getTriagePrompt(ctx.profile.name);
    } catch (e) {
      this.logger.error(
        `triage prompt load failed business_id=${ctx.business_id} trace_id=${ctx.trace_id ?? '-'}: ${(e as Error).message}`,
      );
      this.metrics.bump('triage_synthesized_fallback');
      return {
        triage: synthesizeFallbackTriage({
          priorAssistantLang,
          stalledCountIncoming,
          reason: `prompt_load_failed:${(e as Error).message}`,
        }),
        tokensIn: null,
        tokensOut: null,
      };
    }

    if (ctx.systemPrompt) {
      system = `${ctx.systemPrompt}\n\n${system}`;
    }

    const user = this.buildUserPayload(input);

    let response: { text: string; usage: ChatJsonUsage | null };
    try {
      response = await this.llmClient.chatJson(
        {
          model,
          system,
          user,
          temperature: 0.1,
          maxTokens: 700,
          stopSequences: ['\n\n\n'],
          timeoutMs: this.config.triageTimeoutMs(),
        },
        { stage: 'triage', business_id: ctx.business_id, trace_id: ctx.trace_id },
      );
    } catch (e) {
      const err = e as { kind?: string; message?: string };
      this.logger.error(
        `triage LLM failed business_id=${ctx.business_id} trace_id=${ctx.trace_id ?? '-'} kind=${err?.kind ?? 'unknown'}: ${(e as Error).message}`,
      );
      this.metrics.bump('triage_synthesized_fallback');
      return {
        triage: synthesizeFallbackTriage({
          priorAssistantLang,
          stalledCountIncoming,
          reason: err?.kind ?? 'api_error',
        }),
        tokensIn: null,
        tokensOut: null,
      };
    }

    let parsed = extractJsonObject(response.text);
    if (!parsed) {
      this.metrics.bump('triage_json_parse_error');
      this.metrics.bump('triage_self_correction_used');
      parsed = await this.repairJson(response.text, model, ctx.business_id);
    }

    if (!parsed || !isTriageShape(parsed)) {
      this.metrics.bump('triage_synthesized_fallback');
      return {
        triage: synthesizeFallbackTriage({
          priorAssistantLang,
          stalledCountIncoming,
          reason: parsed ? 'schema_invalid' : 'json_parse_failed',
        }),
        tokensIn: null,
        tokensOut: null,
      };
    }

    return {
      triage: parsed,
      tokensIn: response.usage?.prompt_tokens ?? null,
      tokensOut: response.usage?.completion_tokens ?? null,
    };
  }
}
