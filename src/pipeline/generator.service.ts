import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { OpenRouterClient, OpenRouterError } from './openrouter.client';
import { PromptsService } from './prompts.service';
import { MetricsService } from './metrics.service';
import type {
  HistoryMessage,
  Triage,
  Violation,
} from '../common/types/pipeline.types';

export interface GeneratorFeedback {
  previous_attempt: string;
  violations: Violation[];
}

export interface StreamGeneratorInput {
  message: string;
  history: HistoryMessage[];
  customerContext: Record<string, unknown>;
  triage: Triage;
  feedback: GeneratorFeedback | null;
  kbFile: string;
}

@Injectable()
export class GeneratorService {
  private readonly logger = new Logger(GeneratorService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly client: OpenRouterClient,
    private readonly prompts: PromptsService,
    private readonly metrics: MetricsService,
  ) {}

  private buildUserPayload(args: {
    message: string;
    history: HistoryMessage[];
    customerContext: Record<string, unknown>;
    businessContext: unknown;
    triage: Triage;
    feedback: GeneratorFeedback | null;
  }): string {
    const { message, history, customerContext, businessContext, triage, feedback } = args;
    const parts = [
      `LATEST_MESSAGE: ${message}`,
      `CONVERSATION_HISTORY: ${JSON.stringify(history || [])}`,
      `CUSTOMER_CONTEXT: ${JSON.stringify(customerContext || {})}`,
      `BUSINESS_CONTEXT: ${JSON.stringify(businessContext)}`,
      `TRIAGE: ${JSON.stringify(triage)}`,
    ];
    if (feedback) {
      parts.push(`FEEDBACK: ${JSON.stringify(feedback)}`);
    }
    return parts.join('\n\n');
  }

  async *streamGenerator(input: StreamGeneratorInput): AsyncGenerator<string> {
    const { message, history, customerContext, triage, feedback, kbFile } = input;
    const model = this.config.generatorModel();
    const isRetry = Boolean(feedback);
    const temperature = isRetry ? 0.4 : 0.7;

    const [system, businessContext] = await Promise.all([
      this.prompts.getGeneratorPrompt(kbFile),
      this.prompts.getBusinessContext(kbFile),
    ]);

    const user = this.buildUserPayload({
      message,
      history,
      customerContext,
      businessContext,
      triage,
      feedback,
    });

    let chunkCount = 0;
    let totalLen = 0;
    try {
      for await (const chunk of this.client.chatStream({
        model,
        system,
        user,
        temperature,
        maxTokens: 800,
        stopSequences: ['\n\n\n'],
        timeoutMs: this.config.generatorTimeoutMs(),
      })) {
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
      const kind = e instanceof OpenRouterError ? e.kind : null;
      if (kind === 'timeout') this.metrics.bump('generator_timeout');
      else this.metrics.bump('generator_api_error');
      throw e;
    }
  }
}
