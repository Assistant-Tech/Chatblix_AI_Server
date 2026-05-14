import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { OpenRouterClient, OpenRouterError } from './openrouter.client';
import { PromptsService } from './prompts.service';
import { MetricsService } from './metrics.service';
import { extractJsonObject, isTriageShape } from '../common/utils/pipeline/contracts';
import { synthesizeFallbackTriage } from '../common/utils/pipeline/triage-fallback';
import type {
  ContextPacket,
  LanguageCode,
  Triage,
} from '../common/types/pipeline.types';

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
    private readonly client: OpenRouterClient,
    private readonly prompts: PromptsService,
    private readonly metrics: MetricsService,
  ) {}

  private buildUserPayload(input: CallTriageInput): string {
    const { ctx, message, customerContext, priorAssistantLang, priorAgentQuestion, stalledCountIncoming } = input;
    return [
      `LATEST_MESSAGE: ${message}`,
      `CONVERSATION_HISTORY: ${JSON.stringify(ctx.history || [])}`,
      `CUSTOMER_CONTEXT: ${JSON.stringify(customerContext || {})}`,
      `BUSINESS_CONTEXT: ${JSON.stringify(ctx.profile)}`,
      `PRIOR_ASSISTANT_LANGUAGE: ${priorAssistantLang || 'null'}`,
      `PRIOR_AGENT_QUESTION: ${priorAgentQuestion ? JSON.stringify(priorAgentQuestion) : 'null'}`,
      `STALLED_COUNT_INCOMING: ${stalledCountIncoming || 0}`,
    ].join('\n\n');
  }

  private async repairJson(rawText: string, model: string): Promise<unknown> {
    try {
      const repaired = await this.client.chatJson({
        model,
        system: 'You repair malformed JSON. Output ONLY valid JSON, no prose, no fences.',
        user: `The following was supposed to be valid JSON. Return ONLY corrected JSON, nothing else:\n\n${rawText}`,
        temperature: 0.0,
        maxTokens: 700,
        timeoutMs: this.config.triageTimeoutMs(),
      });
      return extractJsonObject(repaired.text);
    } catch {
      return null;
    }
  }

  async callTriage(input: CallTriageInput): Promise<Triage> {
    const model = this.config.triageModel();
    const { ctx, priorAssistantLang, stalledCountIncoming } = input;

    let system: string;
    try {
      system = await this.prompts.getTriagePrompt(ctx.profile.name);
    } catch (e) {
      this.metrics.bump('triage_synthesized_fallback');
      return synthesizeFallbackTriage({
        priorAssistantLang,
        stalledCountIncoming,
        reason: `prompt_load_failed:${(e as Error).message}`,
      });
    }

    const user = this.buildUserPayload(input);

    let response: { text: string };
    try {
      response = await this.client.chatJson({
        model,
        system,
        user,
        temperature: 0.1,
        maxTokens: 700,
        stopSequences: ['\n\n\n'],
        timeoutMs: this.config.triageTimeoutMs(),
      });
    } catch (e) {
      this.metrics.bump('triage_synthesized_fallback');
      const kind = e instanceof OpenRouterError ? e.kind : 'api_error';
      return synthesizeFallbackTriage({
        priorAssistantLang,
        stalledCountIncoming,
        reason: kind,
      });
    }

    let parsed = extractJsonObject(response.text);
    if (!parsed) {
      this.metrics.bump('triage_json_parse_error');
      this.metrics.bump('triage_self_correction_used');
      parsed = await this.repairJson(response.text, model);
    }

    if (!parsed || !isTriageShape(parsed)) {
      this.metrics.bump('triage_synthesized_fallback');
      return synthesizeFallbackTriage({
        priorAssistantLang,
        stalledCountIncoming,
        reason: parsed ? 'schema_invalid' : 'json_parse_failed',
      });
    }

    return parsed;
  }
}
