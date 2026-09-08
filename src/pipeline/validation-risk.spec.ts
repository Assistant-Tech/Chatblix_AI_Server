import { triageRequiresValidation } from './validation-risk';
import type { Triage } from '../common/types/pipeline.types';

function triage(overrides: Partial<Triage> = {}): Triage {
  return {
    language: { detected: 'romanized_ne' } as any,
    intent_path: 'greeting',
    concern: null,
    named_product: null,
    extracted_data_delta: {},
    closing_state: { in_closing: false } as any,
    buying_signal: false,
    explicit_price_ask: false,
    edge_case_flags: [],
    handoff_required: false,
    stalled_count: 0,
    ...overrides,
  } as Triage;
}

describe('triageRequiresValidation', () => {
  it('skips validation for a plain greeting', () => {
    expect(triageRequiresValidation(triage({ intent_path: 'greeting' }))).toBe(false);
  });

  it('skips for direct_factual / process_question / meta_question', () => {
    for (const intent of ['direct_factual', 'process_question', 'meta_question']) {
      expect(triageRequiresValidation(triage({ intent_path: intent }))).toBe(false);
    }
  });

  it('validates commercial / risky intents', () => {
    for (const intent of ['concern', 'evaluation_question', 'named_product_price_ask', 'buying_signal', 'bargain', 'complaint', 'medical_mention']) {
      expect(triageRequiresValidation(triage({ intent_path: intent }))).toBe(true);
    }
  });

  it('validates a low-risk intent if any hard gate trips', () => {
    expect(triageRequiresValidation(triage({ intent_path: 'direct_factual', buying_signal: true }))).toBe(true);
    expect(triageRequiresValidation(triage({ intent_path: 'greeting', explicit_price_ask: true }))).toBe(true);
    expect(triageRequiresValidation(triage({ intent_path: 'direct_factual', handoff_required: true }))).toBe(true);
    expect(triageRequiresValidation(triage({ intent_path: 'process_question', closing_state: { in_closing: true } as any }))).toBe(true);
    expect(triageRequiresValidation(triage({ intent_path: 'greeting', stalled_count: 1 }))).toBe(true);
    expect(triageRequiresValidation(triage({ intent_path: 'direct_factual', edge_case_flags: ['medical_condition_mentioned'] }))).toBe(true);
  });

  it('validates when triage is missing or synthesized (fail-safe)', () => {
    expect(triageRequiresValidation(null)).toBe(true);
    expect(triageRequiresValidation(undefined)).toBe(true);
    expect(triageRequiresValidation(triage({ _synthesized: true }))).toBe(true);
  });
});
