import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LLMClientService } from './llm-client.service';
import { PromptsService } from './prompts.service';
import { selectToolsForProfile } from './tools.registry';
import { OpenRouterMessage, ChatStreamEvent, cachedSystemMessage } from './openrouter.client';
import { compactHistory } from './history-context';
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

// Assistant-turn prefill that forces the reply to begin with the output contract's
// opening tag. Kept as the bare tag so the model streams only the reply body after it.
const GENERATOR_REPLY_PREFILL = '<reply>';

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
      `CONVERSATION_HISTORY: ${JSON.stringify(compactHistory(ctx.history))}`,
      `CUSTOMER_CONTEXT: ${JSON.stringify(customerContext || {})}`,
      `TRIAGE: ${JSON.stringify(triage)}`,
    ];
    // When an order already exists for this conversation, tell the generator so it
    // stops re-confirming / re-running STAGE 3 and can surface the tracking ref.
    if (ctx.existing_order) {
      parts.push(`EXISTING_ORDER: ${JSON.stringify(ctx.existing_order)}`);
    }
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

    // Cache the (large, stable) system prefix. Without this, the generator's
    // ~19k-token prompt was re-billed in full on every call, every retry, and
    // every tool-loop iteration — it bypassed the client's caching because it
    // hands the client a pre-built `messages` array (overrideMessages path).
    const messages: OpenRouterMessage[] = [
      cachedSystemMessage(system),
      { role: 'user', content: user }
    ];

    if (toolContext && toolContext.length > 0) {
      messages.push(...toolContext);
    }

    // Per-tenant tool gating: only expose tools this tenant's profile enables.
    // Withheld entirely on the forced final pass after the tool-iteration cap.
    const selectedTools = disableTools ? [] : selectToolsForProfile(ctx.profile);
    const tools = selectedTools.length > 0 ? selectedTools : undefined;

    // Output-format enforcement at the API boundary. When NO tools are sent this
    // pass, prefill the assistant turn with `<reply>` so the model physically cannot
    // emit a preamble, a ```-code-fence, a "Looking at the conversation…" reasoning
    // leak, or a stray second `<reply>` before the answer — the exact corruption that
    // shipped in the phantom-order incident (turns 5-6: leaked ``` fence + doubled
    // `<reply>`). We ONLY prefill when `tools` is undefined: prefilling an assistant
    // text turn suppresses tool calls, so tenants with commerce tools (and non-final
    // tool passes) keep the streamed path plus the orchestrator's defensive `<reply>`
    // prepend. The streamed content then starts after `<reply>`, which the orchestrator
    // already handles (it prepends `<reply>` when missing and collapses duplicates).
    if (!tools) {
      messages.push({ role: 'assistant', content: GENERATOR_REPLY_PREFILL });
    }

    try {
      for await (const chunk of this.llmClient.chatStream(
        {
          model,
          temperature,
          maxTokens: 800,
          stopSequences: ['\n\n\n'],
          timeoutMs: this.config.generatorTimeoutMs(),
          tools,
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
