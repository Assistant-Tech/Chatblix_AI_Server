import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LLMClientService } from './llm-client.service';
import { PromptsService } from './prompts.service';
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
}

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

  async *streamGenerator(input: StreamGeneratorInput): AsyncGenerator<string> {
    const { ctx, feedback } = input;
    const model = this.config.generatorModel();
    const isRetry = Boolean(feedback);
    const temperature = isRetry ? 0.4 : 0.7;

    const staticPrompt = await this.prompts.getGeneratorPrompt(ctx.profile.name);
    const system = ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${staticPrompt}` : staticPrompt;
    const user = this.buildUserPayload(input);

    let chunkCount = 0;
    let totalLen = 0;
    try {
      for await (const chunk of this.llmClient.chatStream(
        {
          model,
          system,
          user,
          temperature,
          maxTokens: 800,
          stopSequences: ['\n\n\n'],
          timeoutMs: this.config.generatorTimeoutMs(),
        },
        { stage: 'generator', business_id: ctx.business_id, trace_id: ctx.trace_id },
      )) {
        chunkCount++;
        totalLen += chunk.length;
        yield chunk;
      }
      if (totalLen === 0) {
        this.logger.warn(
          `empty completion model=${model} retry=${isRetry} temp=${temperature} chunks=${chunkCount}`,
        );
      }
    } catch (e) {
      const err = e as { kind?: string };
      if (err?.kind === 'timeout') this.metrics.bump('generator_timeout');
      else this.metrics.bump('generator_api_error');
      throw e;
    }
  }
}
