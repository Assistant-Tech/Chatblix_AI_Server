import { Injectable } from '@nestjs/common';
import type { BusinessProfileDto } from '../common/types/business-profile.dto';
import type {
  IncomingHistoryMessage,
  Triage,
} from '../common/types/pipeline.types';

export type EscalationReason = 'keyword_match' | 'triage_handoff' | 'max_turns_exceeded' | 'negative_sentiment';

// Only these intents trigger a human handoff when triage sets handoff_required.
// Greetings, questions, and general discovery are handled by the generator —
// do NOT escalate them even if the triage model says handoff_required.
const HUMAN_REQUIRED_INTENTS = new Set([
  'complaint',
  'modify_order',
  'invoice_request',
  'reasking',
  'abusive',
  'medical_mention',
  'bulk_inquiry',
  'cancellation_signal',
]);

export interface EscalationCheckResult {
  escalate: boolean;
  reason?: EscalationReason;
  matched_trigger?: string;
  // Human-readable explanation of WHY a human is needed, carried forward so the
  // operator queue shows something meaningful instead of a bare category code.
  handoff_reason?: string;
}

// Static fallbacks for reasons the triage model does not describe in free text.
const REASON_TEXT: Record<EscalationReason, string> = {
  triage_handoff: 'The AI decided a human should take over this conversation.',
  keyword_match: 'The customer used a phrase configured to require a human.',
  max_turns_exceeded: 'The conversation reached the configured turn limit without resolving.',
  negative_sentiment: 'The customer sounded upset — routed to a human.',
};

interface CompiledTrigger {
  re: RegExp;
  trigger: string;
}

@Injectable()
export class EscalationRulesService {
  // Keyed by JSON.stringify(triggers). Cleared (not LRU) when it grows too large
  // because trigger arrays are short-lived profile data that rarely changes.
  private readonly regexCache = new Map<string, CompiledTrigger[]>();

  /**
   * Runs BEFORE the generator. If it returns escalate=true the orchestrator
   * skips the LLM call entirely and returns the profile's handoff_message.
   */
  check(
    message: string,
    history: IncomingHistoryMessage[],
    profile: BusinessProfileDto,
    triage?: Triage | null,
  ): EscalationCheckResult {
    // Only escalate a triage handoff for intents that genuinely need a human.
    // Greetings, questions, and general discovery are handled by the generator —
    // do NOT silence it even if the triage model flags handoff_required.
    if (triage?.handoff_required && HUMAN_REQUIRED_INTENTS.has(triage.intent_path)) {
      // Prefer the triage model's specific free-text reason; fall back to a generic one.
      return {
        escalate: true,
        reason: 'triage_handoff',
        handoff_reason: triage.handoff_reason?.trim() || REASON_TEXT.triage_handoff,
      };
    }

    const { max_turns, sentiment_threshold, triggers } = profile.escalation ?? {};

    if (max_turns !== undefined) {
      const aiTurns = history.filter((h) => h.role === 'assistant').length;
      if (aiTurns >= max_turns) {
        return {
          escalate: true,
          reason: 'max_turns_exceeded',
          handoff_reason: `Conversation reached ${aiTurns} AI turns (limit ${max_turns}) without resolving.`,
        };
      }
    }

    if (sentiment_threshold && triage?.sentiment) {
      const s = triage.sentiment;
      const shouldEscalate =
        sentiment_threshold === 'very_negative'
          ? s === 'very_negative'
          : s === 'negative' || s === 'very_negative';
      if (shouldEscalate) {
        return {
          escalate: true,
          reason: 'negative_sentiment',
          handoff_reason: `Customer sentiment is ${s} — routed to a human.`,
        };
      }
    }

    if (!message || !triggers?.length) {
      return { escalate: false };
    }

    const lower = message.toLowerCase();
    for (const { re, trigger } of this.getCompiledTriggers(triggers)) {
      if (re.test(lower)) {
        return {
          escalate: true,
          reason: 'keyword_match',
          matched_trigger: trigger,
          handoff_reason: `Customer used the trigger phrase "${trigger}".`,
        };
      }
    }
    return { escalate: false };
  }

  private getCompiledTriggers(triggers: string[]): CompiledTrigger[] {
    const key = JSON.stringify(triggers);
    let compiled = this.regexCache.get(key);
    if (!compiled) {
      if (this.regexCache.size >= 500) this.regexCache.clear();
      compiled = triggers
        .filter(Boolean)
        .map((trigger) => {
          const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').toLowerCase();
          // \b doesn't fire reliably between ASCII and non-ASCII (common in Romanized Nepali),
          // so anchor with start/end or non-letter/non-digit Unicode categories.
          const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu');
          return { trigger, re };
        });
      this.regexCache.set(key, compiled);
    }
    return compiled;
  }
}
