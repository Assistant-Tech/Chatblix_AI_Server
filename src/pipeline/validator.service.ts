import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { OpenRouterClient, OpenRouterError } from './openrouter.client';
import { PromptsService } from './prompts.service';
import { MetricsService } from './metrics.service';
import { extractJsonObject, isVerdictShape } from '../common/utils/pipeline/contracts';
import type {
  HistoryMessage,
  Triage,
  Verdict,
} from '../common/types/pipeline.types';

export interface CallValidatorInput {
  message: string;
  history: HistoryMessage[];
  customerContext: Record<string, unknown>;
  triage: Triage;
  candidate: string;
}

@Injectable()
export class ValidatorService {
  private readonly logger = new Logger(ValidatorService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly client: OpenRouterClient,
    private readonly prompts: PromptsService,
    private readonly metrics: MetricsService,
  ) {}

  private buildUserPayload(input: CallValidatorInput): string {
    const { message, history, customerContext, triage, candidate } = input;
    return [
      `LATEST_MESSAGE: ${message}`,
      `CONVERSATION_HISTORY: ${JSON.stringify(history || [])}`,
      `CUSTOMER_CONTEXT: ${JSON.stringify(customerContext || {})}`,
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
      response = await this.client.chatJson({
        model,
        system,
        user,
        temperature: 0.0,
        maxTokens: 700,
        stopSequences: ['\n\n\n'],
        timeoutMs: this.config.validatorTimeoutMs(),
      });
    } catch (e) {
      const kind = e instanceof OpenRouterError ? e.kind : null;
      if (kind === 'timeout') this.metrics.bump('validator_timeout');
      else this.metrics.bump('validator_api_error');
      this.metrics.bump('validator_soft_pass_on_error');
      return this.softPass(kind || 'api_error');
    }

    const parsed = extractJsonObject(response.text);
    if (!parsed || !isVerdictShape(parsed)) {
      this.metrics.bump('validator_soft_pass_on_error');
      return this.softPass(parsed ? 'schema_invalid' : 'json_parse_failed');
    }

    if (Array.isArray(parsed.violations)) {
      parsed.violations = parsed.violations.filter((v) => {
        const id = Number(v?.rule_id);
        const ok = Number.isInteger(id) && id >= 1 && id <= 30;
        if (ok) this.metrics.bumpViolation(id);
        return ok;
      });
    }

    return parsed;
  }
}
