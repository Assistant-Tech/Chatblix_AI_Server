import type { Triage } from '../common/types/pipeline.types';

/**
 * Intent paths low-risk enough that the validator LLM call MAY be skipped (only
 * when `PIPELINE_VALIDATE_RISKY_ONLY` is enabled AND none of the hard gates below
 * trip). These are "answer a simple question" turns: a greeting, a meta/about
 * question, or a grounded factual/process answer. Everything else — concern,
 * evaluation, price, buying, closing, complaint, bargain, medical, etc. — always
 * goes through the validator.
 */
const VALIDATION_SKIP_INTENTS = new Set<string>([
  'greeting',
  'meta_question',
  'direct_factual',
  'process_question',
]);

const RISKY_EDGE_FLAG = /medical|abus|complaint|handoff|price|stall/i;

/**
 * True when a turn MUST be validated. Conservative by design: anything uncertain
 * (no triage, synthesized fallback triage, any commercial/closing/handoff/medical
 * signal) returns true. Only a clearly low-risk turn with all gates clear can
 * return false. Pure function — exported for unit testing.
 */
export function triageRequiresValidation(triage: Triage | null | undefined): boolean {
  if (!triage) return true;
  if (triage._synthesized) return true;

  const intent = String(triage.intent_path ?? '');
  if (!VALIDATION_SKIP_INTENTS.has(intent)) return true;

  if (triage.buying_signal) return true;
  if (triage.explicit_price_ask) return true;
  if (triage.handoff_required) return true;
  if (triage.closing_state?.in_closing) return true;
  if ((triage.stalled_count ?? 0) >= 1) return true;

  const flags = triage.edge_case_flags ?? [];
  if (flags.some((f) => RISKY_EDGE_FLAG.test(String(f)))) return true;

  return false;
}
