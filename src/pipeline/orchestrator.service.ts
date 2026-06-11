import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { TriageService, type TriageCallResult } from './triage.service';
import { GeneratorService } from './generator.service';
import { ValidatorService } from './validator.service';
import { ResponseCleanerService } from './response-cleaner.service';
import { ToneCheckerService } from './tone-checker.service';
import { SafetyFilterService } from './safety-filter.service';
import { EscalationRulesService } from './escalation-rules.service';
import { MetricsService } from './metrics.service';
import { severityScore, verdictPasses } from '../common/utils/pipeline/severity';
import { parsePartialAgentOutput } from '../common/utils/parser';
import { OpenRouterMessage } from './openrouter.client';
import { ToolExecutorService } from './tool-executor.service';
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

// Hard cap on tool-call round-trips within a single generation attempt. Prevents
// a model that keeps emitting tool calls from looping forever (unbounded LLM
// spend + latency). Matches the "max 5 iterations" bound in the analytics design.
const MAX_TOOL_ITERATIONS = 5;

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
    private readonly escalation: EscalationRulesService,
    private readonly metrics: MetricsService,
    private readonly toolExecutor: ToolExecutorService,
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
    let replyText: string;
    if (lang === 'en') {
      replyText = 'One moment, a colleague will respond shortly. Thanks for your patience.';
    } else if (lang === 'mixed') {
      replyText = 'One moment / Ek minute — colleague le respond garchha. Patience ko lagi dhanyabad.';
    } else {
      replyText = 'Hajur, ek minute ma colleague le respond garchha. Patience ko lagi dhanyabad.';
    }
    const metadata = {
      lead_score: 0,
      stage: 'warm',
      intent: 'inquiry',
      extracted_data: {},
      next_step: 'escalate',
      suggested_reply_language: lang,
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
    const triageResult: TriageCallResult = await this.triage.callTriage({
      ctx,
      message,
      customerContext,
      priorAssistantLang,
      priorAgentQuestion,
      stalledCountIncoming,
    });
    const { triage } = triageResult;
    let accTokensIn = triageResult.tokensIn ?? 0;
    let accTokensOut = triageResult.tokensOut ?? 0;
    yield { event: 'triage', data: triage };

    // --- Stage 1.5: Escalation rules (keyword + triage handoff). Short-circuits the generator. ---
    const escalation = this.escalation.check(message, ctx.history, ctx.profile, triage);
    if (escalation.escalate) {
      const detectedLang = (triage?.language?.detected as LanguageCode | undefined) ?? priorAssistantLang ?? 'romanized_ne';
      const handoffText =
        ctx.profile.escalation?.handoff_message ||
        this.synthesizeHandoffCandidate(triage, priorAssistantLang).replace(/<[^>]+>/g, '');
      const shipped = wrapHandoff(handoffText, escalation.reason, detectedLang);
      yield {
        event: 'escalate',
        data: {
          reason: escalation.reason,
          matched_trigger: escalation.matched_trigger,
        },
      };
      const done: DoneInternalData = {
        turn_id: turnId,
        shipped,
        outcome: 'escalate',
        triage,
        attempts: [],
        lastEmittedReplyLen: 0,
        escalated: { reason: escalation.reason ?? 'unknown', matched_trigger: escalation.matched_trigger },
        duration_ms: Date.now() - tStart,
        tokensIn: accTokensIn || null,
        tokensOut: accTokensOut || null,
      };
      yield { event: '_done_internal', data: done };
      return;
    }

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
      let toolContext: OpenRouterMessage[] = [];
      let activeToolCall = false;
      let toolIterations = 0;
      // Once the cap is reached we make one final pass with tools withheld so the
      // model is forced to answer with the data it already gathered.
      let toolsExhausted = false;

      try {
        while (true) {
          activeToolCall = false;
          for await (const chunk of this.generator.streamGenerator({
            ctx,
            message,
            customerContext,
            triage,
            feedback,
            toolContext,
            disableTools: toolsExhausted,
          })) {
            if (chunk.type === 'tool_call') {
              const toolResult = await this.toolExecutor.execute(chunk.name, chunk.arguments, ctx.business_id);
              toolContext.push({
                role: 'assistant',
                content: '',
                tool_calls: [{ id: chunk.id, type: 'function', function: { name: chunk.name, arguments: chunk.arguments } }]
              });
              toolContext.push({
                role: 'tool',
                content: toolResult,
                tool_call_id: chunk.id,
                name: chunk.name
              });
              activeToolCall = true;
              break;
            } else if (chunk.type === 'content') {
              candidate += chunk.text;

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
          }
          if (!activeToolCall) {
            break;
          }

          toolIterations++;
          if (toolIterations >= MAX_TOOL_ITERATIONS) {
            if (toolsExhausted) {
              // Tools were already withheld on this pass yet the model still tried
              // to call one — bail out rather than loop forever.
              this.logger.warn(
                `[pipeline.generator] tool calls continued after cap business_id=${ctx.business_id}; aborting loop`,
              );
              break;
            }
            this.logger.warn(
              `[pipeline.generator] tool-iteration cap (${MAX_TOOL_ITERATIONS}) reached business_id=${ctx.business_id}; forcing a final answer without tools`,
            );
            this.metrics.bump('tool_iteration_cap_hit');
            // Force one clean final pass with tools withheld.
            toolsExhausted = true;
            candidate = '';
            prefixDecided = false;
            lastEmittedReplyLen = 0;
          }
        }

        // Strip markdown code fences that some models wrap around the output,
        // then collapse any duplicate <reply> prefix inserted during streaming.
        candidate = candidate.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '').trim();
        candidate = candidate.replace(/^<reply>\s*<reply>/i, '<reply>');

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

      const validatorResult = await this.validator.callValidator({
        ctx,
        message,
        customerContext,
        triage,
        candidate,
      });
      accTokensIn += validatorResult.tokensIn ?? 0;
      accTokensOut += validatorResult.tokensOut ?? 0;

      // Compose tone + safety violations on top of the validator verdict.
      const composed = this.composeVerdict(candidate, ctx.profile, validatorResult.verdict);

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

    // TurnLog write lives in ReplyService (5.3) — it has the business_id,
    // conversation_id, contact_id, channel needed to populate the new TurnLog
    // schema. Orchestrator just returns the data.
    const done: DoneInternalData = {
      turn_id: turnId,
      shipped,
      outcome,
      triage,
      attempts,
      lastEmittedReplyLen,
      duration_ms: Date.now() - tStart,
      tokensIn: accTokensIn || null,
      tokensOut: accTokensOut || null,
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

function wrapHandoff(text: string, reason: string | undefined, lang: LanguageCode = 'romanized_ne'): string {
  const metadata = {
    next_step: 'escalate',
    handoff_required: true,
    handoff_context: `escalation:${reason ?? 'unknown'}`,
    suggested_reply_language: lang,
    tags: ['escalate', reason ?? 'unknown'],
  };
  return `<reply>${text}</reply><metadata>${JSON.stringify(metadata)}</metadata>`;
}
