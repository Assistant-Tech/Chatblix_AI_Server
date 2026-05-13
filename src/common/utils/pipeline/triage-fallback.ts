import type { LanguageCode, Triage } from '../../types/pipeline.types';

export interface SynthesizeFallbackTriageInput {
  priorAssistantLang?: LanguageCode | null;
  stalledCountIncoming?: number;
  reason?: string;
}

export function synthesizeFallbackTriage(input: SynthesizeFallbackTriageInput = {}): Triage {
  const { priorAssistantLang = null, stalledCountIncoming = 0, reason = 'triage_unavailable' } = input;

  const detected: LanguageCode = priorAssistantLang ?? 'romanized_ne';

  return {
    language: {
      detected,
      inheritance_used: Boolean(priorAssistantLang),
      markers_found: [],
      language_inheritance_reason: priorAssistantLang
        ? `Inherited from prior assistant turn (${reason}).`
        : null,
    },
    intent_path: 'confusion',
    concern: null,
    named_product: null,
    extracted_data_delta: {
      name: null,
      phone: null,
      email: null,
      address: null,
      location: null,
      product_interest: null,
      budget_range: null,
      timeline: null,
    },
    closing_state: {
      in_closing: false,
      stage: null,
      stage_1_already_fired: false,
      missing_fields: [],
    },
    buying_signal: false,
    explicit_price_ask: false,
    process_question_topic: null,
    edge_case_flags: [],
    handoff_required: stalledCountIncoming >= 2,
    handoff_reason: stalledCountIncoming >= 2 ? 'Stalled count threshold reached during triage failure.' : null,
    stalled_count: stalledCountIncoming,
    notes_for_generator: `Triage degraded (${reason}); re-explain shorter, ask ONE specific thing.`,
    _synthesized: true,
  };
}
