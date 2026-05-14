import { Injectable } from '@nestjs/common';

const LEADING_LABEL_RE = /^\s*(?:AI|Assistant|Bot|Agent)\s*:\s*/i;
const TRAILING_SYSTEM_NOTE_RE = /\n+\s*(?:\(system|\(note|—\s*system note|⟪[^⟫]*⟫)[^\n]*$/i;

@Injectable()
export class ResponseCleanerService {
  /**
   * Best-effort sanitation for raw LLM output before validation / shipping.
   * Pure, deterministic, idempotent — running it twice produces the same
   * result as once.
   */
  clean(raw: string): string {
    if (!raw) return '';
    let out = raw;

    // Strip a leading "AI:" / "Assistant:" / etc. label some models still emit
    // despite the prompt's "first character must be <" rule.
    out = out.replace(LEADING_LABEL_RE, '');

    // Strip trailing meta annotations like "(system note: ...)".
    out = out.replace(TRAILING_SYSTEM_NOTE_RE, '');

    // Collapse runs of 3+ blank lines into a single blank line.
    out = out.replace(/\n{3,}/g, '\n\n');

    return out.trim();
  }
}
