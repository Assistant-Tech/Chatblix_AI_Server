import type { LanguageCode, Triage } from '../../types/pipeline.types';

export interface SynthesizeFallbackTriageInput {
  priorAssistantLang?: LanguageCode | null;
  stalledCountIncoming?: number;
  reason?: string;
}

export function synthesizeFallbackTriage(input: SynthesizeFallbackTriageInput = {}): Triage {
  const { priorAssistantLang = null, stalledCountIncoming = 0, reason = 'triage_unavailable' } = input;

  const detected: LanguageCode = priorAssistantLang ?? 'romanized_ne';
  const stalled = stalledCountIncoming >= 2;

  return {
    language: {
      detected,
      inheritance_used: Boolean(priorAssistantLang),
      markers_found: [],
      language_inheritance_reason: priorAssistantLang
        ? `Inherited from prior assistant turn (${reason}).`
        : null,
    },
    // When the conversation has stalled we set handoff_required below, but the
    // handoff only actually fires if intent_path is in EscalationRulesService's
    // HUMAN_REQUIRED_INTENTS. 'confusion' is NOT in that set, so a stalled fallback
    // would silently fail to escalate — use 'reasking' (which IS) so the handoff
    // and its synthesized handoff_reason take effect.
    intent_path: stalled ? 'reasking' : 'confusion',
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
    handoff_required: stalled,
    handoff_reason: stalled ? 'Stalled count threshold reached during triage failure.' : null,
    stalled_count: stalledCountIncoming,
    notes_for_generator: `Triage degraded (${reason}); re-explain shorter, ask ONE specific thing.`,
    _synthesized: true,
  };
}
