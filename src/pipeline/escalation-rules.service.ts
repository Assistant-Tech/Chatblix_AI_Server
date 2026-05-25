import { Injectable } from '@nestjs/common';
import type { BusinessProfileDto } from '../common/types/business-profile.dto';
import type {
  IncomingHistoryMessage,
  Triage,
} from '../common/types/pipeline.types';

export type EscalationReason = 'keyword_match' | 'triage_handoff';

export interface EscalationCheckResult {
  escalate: boolean;
  reason?: EscalationReason;
  matched_trigger?: string;
}

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
    void history; // currently unused; kept for future sentiment-over-time rules

    if (triage?.handoff_required) {
      return { escalate: true, reason: 'triage_handoff' };
    }

    const triggers = profile.escalation?.triggers ?? [];
    if (!message || triggers.length === 0) {
      return { escalate: false };
    }

    const lower = message.toLowerCase();
    for (const { re, trigger } of this.getCompiledTriggers(triggers)) {
      if (re.test(lower)) {
        return { escalate: true, reason: 'keyword_match', matched_trigger: trigger };
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
