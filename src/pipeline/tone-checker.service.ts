import { Injectable } from '@nestjs/common';
import type { BusinessProfileDto } from '../common/types/business-profile.dto';

export interface ToneCheckResult {
  pass: boolean;
  violations: string[];
}

@Injectable()
export class ToneCheckerService {
  /**
   * Pure, deterministic scan for banned phrases from `profile.tone.dont`.
   * Cheap (<5ms) — runs after generator on every attempt.
   */
  check(reply: string, profile: BusinessProfileDto): ToneCheckResult {
    const dont = profile.tone?.dont ?? [];
    if (!reply || dont.length === 0) {
      return { pass: true, violations: [] };
    }

    const lower = reply.toLowerCase();
    const violations: string[] = [];
    for (const banned of dont) {
      if (!banned) continue;
      if (lower.includes(banned.toLowerCase())) {
        violations.push(`tone.dont: "${banned}"`);
      }
    }
    return { pass: violations.length === 0, violations };
  }
}
