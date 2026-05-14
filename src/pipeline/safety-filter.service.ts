import { Injectable } from '@nestjs/common';

export interface SafetyCheckResult {
  pass: boolean;
  violations: string[];
}

// Conservative PII patterns. The goal is to flag obvious leaks
// (the AI shouldn't be quoting back emails/phones/cards), not to do
// full DLP — that's the main backend's job for inbound channel content.
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
// 10+ digit runs with optional spaces / dashes / +country prefix.
const PHONE_RE = /(?:\+?\d[\s\-]?){10,}/;
// 13-19 digit groupings — covers most card numbers; intentionally loose.
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/;

@Injectable()
export class SafetyFilterService {
  /**
   * Regex sweep for obvious PII leaks in the assistant reply. Cheap (<5ms);
   * runs after generator on every attempt alongside the tone check.
   */
  check(reply: string): SafetyCheckResult {
    if (!reply) return { pass: true, violations: [] };

    const violations: string[] = [];
    if (EMAIL_RE.test(reply)) violations.push('pii.email');
    if (CARD_RE.test(reply)) violations.push('pii.card_number');
    else if (PHONE_RE.test(reply)) violations.push('pii.phone');

    return { pass: violations.length === 0, violations };
  }
}
