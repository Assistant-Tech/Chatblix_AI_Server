import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LLMClientService } from './llm-client.service';
import { PromptsService } from './prompts.service';
import { MetricsService } from './metrics.service';
import { extractJsonObject, isVerdictShape } from '../common/utils/pipeline/contracts';
import type {
  ContextPacket,
  Triage,
  Verdict,
} from '../common/types/pipeline.types';

export interface CallValidatorInput {
  ctx: ContextPacket;
  message: string;
  triage: Triage;
  candidate: string;
  customerContext: Record<string, unknown>;
}

@Injectable()
export class ValidatorService {
  private readonly logger = new Logger(ValidatorService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly llmClient: LLMClientService,
    private readonly prompts: PromptsService,
    private readonly metrics: MetricsService,
  ) {}

  private buildUserPayload(input: CallValidatorInput): string {
    const { ctx, message, customerContext, triage, candidate } = input;
    return [
      `LATEST_MESSAGE: ${message}`,
      `CONVERSATION_HISTORY: ${JSON.stringify(ctx.history || [])}`,
      `CUSTOMER_CONTEXT: ${JSON.stringify(customerContext || {})}`,
      `BUSINESS_CONTEXT: ${JSON.stringify(ctx.profile)}`,
      `TRIAGE: ${JSON.stringify(triage)}`,
      `CANDIDATE: ${candidate}`,
    ].join('\n\n');
  }

  private softPass(reason: string): Verdict {
    return {
      pass: true,
      violations: [],
      metadata_valid: true,
      language_match: true,
      summary: `validator_soft_pass:${reason}`,
      _soft_pass: true,
    };
  }

  async callValidator(input: CallValidatorInput): Promise<Verdict> {
    const model = this.config.validatorModel();

    let system: string;
    try {
      system = await this.prompts.getValidatorPrompt();
    } catch (e) {
      this.metrics.bump('validator_soft_pass_on_error');
      return this.softPass(`prompt_load_failed:${(e as Error).message}`);
    }

    const user = this.buildUserPayload(input);

    let response: { text: string };
    try {
      response = await this.llmClient.chatJson(
        {
          model,
          system,
          user,
          temperature: 0.0,
          maxTokens: 700,
          stopSequences: ['\n\n\n'],
          timeoutMs: this.config.validatorTimeoutMs(),
        },
        { stage: 'validator', business_id: input.ctx.business_id, trace_id: input.ctx.trace_id },
      );
    } catch (e) {
      const err = e as { kind?: string };
      if (err?.kind === 'timeout') this.metrics.bump('validator_timeout');
      else this.metrics.bump('validator_api_error');
      this.metrics.bump('validator_soft_pass_on_error');
      return this.softPass(err?.kind ?? 'api_error');
    }

    const parsed = extractJsonObject(response.text);
    if (!parsed || !isVerdictShape(parsed)) {
      this.metrics.bump('validator_soft_pass_on_error');
      return this.softPass(parsed ? 'schema_invalid' : 'json_parse_failed');
    }

    if (Array.isArray(parsed.violations)) {
      parsed.violations = parsed.violations.filter((v) => {
        const id = Number(v?.rule_id);
        const ok = Number.isInteger(id) && id >= 1 && id <= 33;
        if (ok) this.metrics.bumpViolation(id);
        return ok;
      });

      const highCount = parsed.violations.filter((v) => v.severity === 'high').length;
      const mediumCount = parsed.violations.filter((v) => v.severity === 'medium').length;
      parsed.pass =
        highCount === 0 &&
        mediumCount < 2 &&
        parsed.metadata_valid !== false &&
        parsed.language_match !== false;
    }

    return parsed;
  }
}
