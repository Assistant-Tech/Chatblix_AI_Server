import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LLMClientService } from './llm-client.service';
import { PromptsService } from './prompts.service';
import { AVAILABLE_TOOLS } from './tools.registry';
import { OpenRouterMessage, ChatStreamEvent } from './openrouter.client';
import { MetricsService } from './metrics.service';
import type {
  ContextPacket,
  Triage,
  Violation,
} from '../common/types/pipeline.types';

export interface GeneratorFeedback {
  previous_attempt: string;
  violations: Violation[];
}

export interface StreamGeneratorInput {
  ctx: ContextPacket;
  message: string;
  triage: Triage;
  feedback: GeneratorFeedback | null;
  customerContext: Record<string, unknown>;
  toolContext?: OpenRouterMessage[];
  // When true, the tools array is withheld so the model is forced to answer
  // with the data it already has (used after the tool-iteration cap is hit).
  disableTools?: boolean;
}

export type GeneratorEvent = ChatStreamEvent;

@Injectable()
export class GeneratorService {
  private readonly logger = new Logger(GeneratorService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly llmClient: LLMClientService,
    private readonly prompts: PromptsService,
    private readonly metrics: MetricsService,
  ) {}

  private buildUserPayload(args: StreamGeneratorInput): string {
    const { ctx, message, customerContext, triage, feedback } = args;
    const parts = [
      `LATEST_MESSAGE: ${message}`,
      `CONVERSATION_HISTORY: ${JSON.stringify(ctx.history || [])}`,
      `CUSTOMER_CONTEXT: ${JSON.stringify(customerContext || {})}`,
      `TRIAGE: ${JSON.stringify(triage)}`,
    ];
    if (feedback) {
      parts.push(`FEEDBACK: ${JSON.stringify(feedback)}`);
    }
    return parts.join('\n\n');
  }

  async *streamGenerator(input: StreamGeneratorInput): AsyncGenerator<GeneratorEvent> {
    const { ctx, feedback, toolContext, disableTools } = input;
    const model = this.config.generatorModel();
    const isRetry = Boolean(feedback);
    const temperature = isRetry ? 0.4 : 0.7;

    const staticPrompt = await this.prompts.getGeneratorPrompt(ctx.profile.name);
    const system = ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${staticPrompt}` : staticPrompt;
    const user = this.buildUserPayload(input);

    let chunkCount = 0;
    let totalLen = 0;

    const messages: OpenRouterMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];

    if (toolContext && toolContext.length > 0) {
      messages.push(...toolContext);
    }

    try {
      for await (const chunk of this.llmClient.chatStream(
        {
          model,
          temperature,
          maxTokens: 800,
          stopSequences: ['\n\n\n'],
          timeoutMs: this.config.generatorTimeoutMs(),
          tools: disableTools ? undefined : AVAILABLE_TOOLS,
          messages,
          system, // Fallback for clients needing it
          user,   // Fallback
        },
        { stage: 'generator', business_id: ctx.business_id, trace_id: ctx.trace_id },
      )) {
        if (chunk.type === 'content') {
          chunkCount++;
          totalLen += chunk.text.length;
        }
        yield chunk;
      }
      if (totalLen === 0) {
        this.logger.warn(
          `empty completion model=${model} retry=${isRetry} temp=${temperature} chunks=${chunkCount}`,
        );
      }
    } catch (e) {
      const err = e as { kind?: string; message?: string };
      this.logger.error(
        `generator stream failed model=${model} business_id=${ctx.business_id} trace_id=${ctx.trace_id ?? '-'} retry=${isRetry} kind=${err?.kind ?? 'unknown'}: ${(e as Error).message}`,
      );
      if (err?.kind === 'timeout') this.metrics.bump('generator_timeout');
      else this.metrics.bump('generator_api_error');
      throw e;
    }
  }
}
