import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LLMClientService } from './llm-client.service';
import { PromptsService } from './prompts.service';
import { MetricsService } from './metrics.service';
import { extractJsonObject, isVerdictShape } from '../common/utils/pipeline/contracts';
import { slimProfileForContext } from './profile-context';
import type { ChatJsonUsage } from './openrouter.client';
import type {
  ContextPacket,
  Triage,
  Verdict,
  Violation,
} from '../common/types/pipeline.types';

// Medium-severity rules that are purely stylistic/tone (vs. substantive quality).
// Violations of these count half toward the medium pass-gate so two pure-tone
// slips don't force a regeneration. Keep in sync with 03_validator.md "Severity
// assignment". 12=no_stiff_phrases, 28=no_corporate_hedge, 33=particle_overuse.
const STYLISTIC_MEDIUM_RULES = new Set<number>([12, 28, 33]);

/**
 * Recompute the validator pass gate from the emitted violations.
 *
 * pass = no HIGH violations AND weighted-medium score < 2 AND metadata/language
 * not explicitly false. Stylistic mediums (see STYLISTIC_MEDIUM_RULES) are
 * half-weighted, so two pure-tone slips pass but two substantive slips (or one
 * tone + one substantive) block. Pure function — exported for unit testing.
 */
export function computeValidatorPass(
  violations: Violation[],
  metadataValid: boolean | undefined,
  languageMatch: boolean | undefined,
): { pass: boolean; highCount: number; mediumCount: number; weightedMedium: number } {
  const list = Array.isArray(violations) ? violations : [];
  const highCount = list.filter((v) => v.severity === 'high').length;
  const mediumViolations = list.filter((v) => v.severity === 'medium');
  const weightedMedium = mediumViolations.reduce(
    (sum, v) => sum + (STYLISTIC_MEDIUM_RULES.has(Number(v.rule_id)) ? 0.5 : 1),
    0,
  );
  const pass =
    highCount === 0 && weightedMedium < 2 && metadataValid !== false && languageMatch !== false;
  return { pass, highCount, mediumCount: mediumViolations.length, weightedMedium };
}

export interface ValidatorCallResult {
  verdict: Verdict;
  tokensIn: number | null;
  tokensOut: number | null;
}

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
      `BUSINESS_CONTEXT: ${JSON.stringify(slimProfileForContext(ctx.profile))}`,
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

  async callValidator(input: CallValidatorInput): Promise<ValidatorCallResult> {
    const model = this.config.validatorModel();

    let system: string;
    try {
      system = await this.prompts.getValidatorPrompt();
    } catch (e) {
      this.logger.error(
        `validator prompt load failed business_id=${input.ctx.business_id} trace_id=${input.ctx.trace_id ?? '-'}: ${(e as Error).message}`,
      );
      this.metrics.bump('validator_soft_pass_on_error');
      return { verdict: this.softPass(`prompt_load_failed:${(e as Error).message}`), tokensIn: null, tokensOut: null };
    }

    if (input.ctx.systemPrompt) {
      system = `${input.ctx.systemPrompt}\n\n${system}`;
    }

    const user = this.buildUserPayload(input);

    let response: { text: string; usage: ChatJsonUsage | null };
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
      const err = e as { kind?: string; message?: string };
      this.logger.error(
        `validator LLM failed business_id=${input.ctx.business_id} trace_id=${input.ctx.trace_id ?? '-'} kind=${err?.kind ?? 'unknown'}: ${(e as Error).message}`,
      );
      if (err?.kind === 'timeout') this.metrics.bump('validator_timeout');
      else this.metrics.bump('validator_api_error');
      this.metrics.bump('validator_soft_pass_on_error');
      return { verdict: this.softPass(err?.kind ?? 'api_error'), tokensIn: null, tokensOut: null };
    }

    const parsed = extractJsonObject(response.text);
    if (!parsed || !isVerdictShape(parsed)) {
      this.metrics.bump('validator_soft_pass_on_error');
      return {
        verdict: this.softPass(parsed ? 'schema_invalid' : 'json_parse_failed'),
        tokensIn: null,
        tokensOut: null,
      };
    }

    if (Array.isArray(parsed.violations)) {
      parsed.violations = parsed.violations.filter((v) => {
        const id = Number(v?.rule_id);
        const ok = Number.isInteger(id) && id >= 1 && id <= 33;
        if (ok) this.metrics.bumpViolation(id);
        return ok;
      });

      const gate = computeValidatorPass(
        parsed.violations,
        parsed.metadata_valid,
        parsed.language_match,
      );
      parsed.pass = gate.pass;

      if (!parsed.pass) {
        const summary = parsed.violations
          .map((v) => `#${v.rule_id}(${v.severity})${v.fix_hint ? ': ' + v.fix_hint : ''}`)
          .join(' | ');
        this.logger.warn(
          `validator FAIL trace_id=${input.ctx.trace_id ?? '-'} high=${gate.highCount} medium=${gate.mediumCount} ` +
            `weighted_medium=${gate.weightedMedium} metadata_valid=${parsed.metadata_valid} ` +
            `language_match=${parsed.language_match} violations=[${summary}]`,
        );
      }
    }

    return {
      verdict: parsed,
      tokensIn: response.usage?.prompt_tokens ?? null,
      tokensOut: response.usage?.completion_tokens ?? null,
    };
  }
}
