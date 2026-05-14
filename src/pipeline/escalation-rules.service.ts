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

@Injectable()
export class EscalationRulesService {
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
    for (const trigger of triggers) {
      if (!trigger) continue;
      if (matchesWordBoundary(lower, trigger.toLowerCase())) {
        return { escalate: true, reason: 'keyword_match', matched_trigger: trigger };
      }
    }
    return { escalate: false };
  }
}

function matchesWordBoundary(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b doesn't fire reliably between an ASCII char and a non-ASCII char (common
  // in Romanized Nepali / Devanagari), so anchor with start/end or non-letter.
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu');
  return re.test(haystack);
}
