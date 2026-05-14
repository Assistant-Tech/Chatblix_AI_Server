import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { TriageService } from './triage.service';
import { GeneratorService } from './generator.service';
import { ValidatorService } from './validator.service';
import { ResponseCleanerService } from './response-cleaner.service';
import { ToneCheckerService } from './tone-checker.service';
import { SafetyFilterService } from './safety-filter.service';
import { MetricsService } from './metrics.service';
import { severityScore, verdictPasses } from '../common/utils/pipeline/severity';
import { parsePartialAgentOutput } from '../common/utils/parser';
import type {
  DoneInternalData,
  LanguageCode,
  PipelineAttempt,
  PipelineEvent,
  StreamTurnInput,
  Triage,
  Verdict,
  Violation,
} from '../common/types/pipeline.types';

const TONE_RULE_ID = 90;
const SAFETY_RULE_ID = 91;

@Injectable()
export class PipelineOrchestratorService {
  private readonly logger = new Logger(PipelineOrchestratorService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly triage: TriageService,
    private readonly generator: GeneratorService,
    private readonly validator: ValidatorService,
    private readonly cleaner: ResponseCleanerService,
    private readonly tone: ToneCheckerService,
    private readonly safety: SafetyFilterService,
    private readonly metrics: MetricsService,
  ) {}

  private pickBest(attempts: PipelineAttempt[]): PipelineAttempt | null {
    if (!attempts.length) return null;
    let best = attempts[0];
    let bestScore = severityScore(best.verdict?.violations);
    for (let i = 1; i < attempts.length; i++) {
      const s = severityScore(attempts[i].verdict?.violations);
      if (s < bestScore) {
        best = attempts[i];
        bestScore = s;
      }
    }
    return best;
  }

  private synthesizeHandoffCandidate(triage: Triage | null, priorLang: LanguageCode | null): string {
    const lang = (triage?.language?.detected as LanguageCode | undefined) || priorLang || 'romanized_ne';
    const replyText =
      lang === 'en'
        ? 'One moment, a colleague will respond shortly. Thanks for your patience.'
        : 'Hajur, ek minute ma colleague le respond garchha. Patience ko lagi dhanyabad.';
    const metadata = {
      lead_score: 0,
      stage: 'warm',
      intent: 'inquiry',
      extracted_data: {},
      next_step: 'escalate',
      suggested_reply_language: lang === 'en' ? 'en' : 'romanized_ne',
      handoff_required: true,
      handoff_context: 'System error during reply generation. Manual response needed.',
      tags: ['system_error', 'handoff'],
    };
    return `<reply>${replyText}</reply><metadata>${JSON.stringify(metadata)}</metadata>`;
  }

  async *streamTurn(input: StreamTurnInput): AsyncGenerator<PipelineEvent> {
    const {
      ctx,
      message,
      customerContext,
      priorAssistantLang,
      priorAgentQuestion,
      stalledCountIncoming,
    } = input;

    const turnId = randomUUID();
    const tStart = Date.now();
    this.metrics.bump('total_turns');

    // --- Stage 1: Triage ---
    const triage = await this.triage.callTriage({
      ctx,
      message,
      customerContext,
      priorAssistantLang,
      priorAgentQuestion,
      stalledCountIncoming,
    });
    yield { event: 'triage', data: triage };

    // --- Stage 2 + 3: Generator → Validator + Tone + Safety, up to maxRetries+1 attempts ---
    const attempts: PipelineAttempt[] = [];
    const limit = this.config.maxRetries() + 1;
    let lastEmittedReplyLen = 0;

    for (let attemptIdx = 0; attemptIdx < limit; attemptIdx++) {
      const feedback =
        attemptIdx > 0
          ? {
              previous_attempt: attempts[attempts.length - 1].candidate,
              violations: attempts[attempts.length - 1].verdict.violations,
            }
          : null;

      if (attemptIdx > 0) {
        yield {
          event: 'regenerate',
          data: {
            reason: 'validator_fail',
            attempt: attemptIdx,
            violations: attempts[attempts.length - 1].verdict.violations,
          },
        };
        lastEmittedReplyLen = 0;
      }

      let candidate = '';
      let prefixDecided = false;
      try {
        for await (const chunk of this.generator.streamGenerator({
          ctx,
          message,
          customerContext,
          triage,
          feedback,
        })) {
          candidate += chunk;

          if (!prefixDecided && candidate.length >= 7) {
            if (!/^<reply>/i.test(candidate)) {
              candidate = '<reply>' + candidate;
            }
            candidate = candidate.replace(/^<reply>\s*<reply>/i, '<reply>');
            prefixDecided = true;
          }

          const partial = parsePartialAgentOutput(candidate, message);
          if (partial.reply && partial.reply.length > lastEmittedReplyLen) {
            const newText = partial.reply.slice(lastEmittedReplyLen);
            lastEmittedReplyLen = partial.reply.length;
            yield { event: 'token', data: { content: newText, attempt: attemptIdx } };
          }
        }

        if (!prefixDecided && candidate && !/^<reply>/i.test(candidate)) {
          candidate = '<reply>' + candidate;
        }
      } catch (e) {
        const err = e as { kind?: string; status?: number; message?: string };
        this.logger.error(
          `[pipeline.generator] attempt ${attemptIdx} failed: kind=${err?.kind || 'unknown'} status=${
            err?.status || 'n/a'
          } message=${err?.message || String(e)}`,
        );

        if (attemptIdx + 1 < limit) {
          attempts.push({
            attempt_idx: attemptIdx,
            candidate,
            verdict: {
              pass: false,
              violations: [
                {
                  rule_id: 1,
                  rule_name: 'output_format_strict',
                  severity: 'high',
                  evidence: `generator_error: ${err.message || e}`,
                  fix_hint: 'Regenerate cleanly.',
                },
              ],
              metadata_valid: false,
              language_match: true,
            },
          });
          continue;
        }
        candidate = this.synthesizeHandoffCandidate(triage, priorAssistantLang);
      }

      const verdict: Verdict = await this.validator.callValidator({
        ctx,
        message,
        customerContext,
        triage,
        candidate,
      });

      // Compose tone + safety violations on top of the validator verdict.
      const composed = this.composeVerdict(candidate, ctx.profile, verdict);

      attempts.push({ attempt_idx: attemptIdx, candidate, verdict: composed });

      if (verdictPasses(composed)) break;
    }

    // --- Pick what to ship ---
    const lastAttempt = attempts[attempts.length - 1];
    const passed = verdictPasses(lastAttempt?.verdict);
    let shipped = passed ? lastAttempt.candidate : this.pickBest(attempts)?.candidate || '';

    let outcome: string;
    if (passed) {
      outcome = lastAttempt.attempt_idx === 0 ? 'pass_first_try' : 'pass_after_retry';
      this.metrics.bump(outcome === 'pass_first_try' ? 'turn_pass_first_try' : 'turn_pass_after_retry');
    } else {
      outcome = 'ship_with_violations';
      this.metrics.bump('turn_ship_with_violations');
    }

    const hasReplyBody =
      /<reply>([\s\S]*?)<\/reply>/i.test(shipped) &&
      shipped
        .replace(/<\/?(reply|metadata)[^>]*>/gi, '')
        .replace(/\{[\s\S]*\}/g, '')
        .trim().length > 1;
    if (!shipped || !hasReplyBody) {
      shipped = this.synthesizeHandoffCandidate(triage, priorAssistantLang);
      outcome = 'ship_with_violations';
      this.metrics.bump('turn_ship_with_violations');
    }

    if (shipped !== lastAttempt.candidate) {
      yield {
        event: 'regenerate',
        data: { reason: 'ship_least_bad', attempt: -1 },
      };
      lastEmittedReplyLen = 0;
    }

    yield {
      event: 'verdict',
      data: {
        pass: passed,
        outcome,
        violations: this.pickBest(attempts)?.verdict?.violations || [],
      },
    };

    // TurnLog write lands in Phase 5.3 (ReplyService) — it has the business_id,
    // conversation_id, contact_id, channel needed to populate the new TurnLog
    // schema. Orchestrator just returns the data.
    void turnId;
    void tStart;

    const done: DoneInternalData = {
      turn_id: turnId,
      shipped,
      outcome,
      triage,
      attempts,
      lastEmittedReplyLen,
    };
    yield { event: '_done_internal', data: done };
  }

  private composeVerdict(
    candidate: string,
    profile: StreamTurnInput['ctx']['profile'],
    verdict: Verdict,
  ): Verdict {
    const replyText = extractReplyText(candidate);
    const cleaned = this.cleaner.clean(replyText);
    const tone = this.tone.check(cleaned, profile);
    const safety = this.safety.check(cleaned);

    if (tone.pass && safety.pass) return verdict;

    const added: Violation[] = [];
    for (const t of tone.violations) {
      added.push({
        rule_id: TONE_RULE_ID,
        rule_name: 'tone.dont_match',
        severity: 'high',
        evidence: t,
        fix_hint: 'Rephrase without the banned phrase or pattern.',
      });
    }
    for (const s of safety.violations) {
      added.push({
        rule_id: SAFETY_RULE_ID,
        rule_name: 'safety.pii_leak',
        severity: 'high',
        evidence: s,
        fix_hint: 'Remove the PII; redirect the customer to provide it through a secure channel.',
      });
    }

    return {
      ...verdict,
      pass: false,
      _soft_pass: false,
      violations: [...(verdict.violations ?? []), ...added],
    };
  }
}

function extractReplyText(candidate: string): string {
  if (!candidate) return '';
  const m = /<reply>([\s\S]*?)<\/reply>/i.exec(candidate);
  return m ? m[1] : candidate;
}
