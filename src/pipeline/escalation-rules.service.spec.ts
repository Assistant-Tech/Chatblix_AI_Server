import { EscalationRulesService } from './escalation-rules.service';
import type { BusinessProfileDto } from '../common/types/business-profile.dto';
import type { IncomingHistoryMessage, Triage } from '../common/types/pipeline.types';

function makeTriage(overrides: Partial<Triage> = {}): Triage {
  return {
    intent_path: 'greeting',
    handoff_required: false,
    ...overrides,
  } as Triage;
}

const emptyProfile = {} as BusinessProfileDto;
const noHistory: IncomingHistoryMessage[] = [];

describe('EscalationRulesService — triage handoff intent gate (C1)', () => {
  let svc: EscalationRulesService;
  beforeEach(() => {
    svc = new EscalationRulesService();
  });

  it('does NOT escalate a handoff flagged on a conversational intent (greeting)', () => {
    const triage = makeTriage({ intent_path: 'greeting', handoff_required: true });
    const result = svc.check('hi there', noHistory, emptyProfile, triage);
    expect(result.escalate).toBe(false);
  });

  it('does NOT escalate a handoff on meta_question / unknown intents', () => {
    const triage = makeTriage({ intent_path: 'meta_question', handoff_required: true });
    expect(svc.check('what can you do?', noHistory, emptyProfile, triage).escalate).toBe(false);
  });

  it('DOES escalate a handoff on a human-required intent (complaint)', () => {
    const triage = makeTriage({ intent_path: 'complaint', handoff_required: true });
    const result = svc.check('this is terrible', noHistory, emptyProfile, triage);
    expect(result.escalate).toBe(true);
    expect(result.reason).toBe('triage_handoff');
  });

  it('DOES escalate a handoff on cancellation_signal', () => {
    const triage = makeTriage({ intent_path: 'cancellation_signal', handoff_required: true });
    expect(svc.check('cancel my order', noHistory, emptyProfile, triage).escalate).toBe(true);
  });

  it('does not escalate when handoff_required is false even on a human-required intent', () => {
    const triage = makeTriage({ intent_path: 'complaint', handoff_required: false });
    expect(svc.check('question', noHistory, emptyProfile, triage).escalate).toBe(false);
  });
});

describe('EscalationRulesService — handoff_reason propagation', () => {
  let svc: EscalationRulesService;
  beforeEach(() => {
    svc = new EscalationRulesService();
  });

  it('carries the triage free-text handoff_reason on a triage_handoff', () => {
    const triage = makeTriage({
      intent_path: 'medical_mention',
      handoff_required: true,
      handoff_reason: 'Customer mentioned eczema; needs professional advice.',
    });
    const result = svc.check('is it safe for eczema?', noHistory, emptyProfile, triage);
    expect(result.reason).toBe('triage_handoff');
    expect(result.handoff_reason).toBe('Customer mentioned eczema; needs professional advice.');
  });

  it('falls back to a generic reason when triage gives no handoff_reason', () => {
    const triage = makeTriage({ intent_path: 'complaint', handoff_required: true });
    const result = svc.check('this is terrible', noHistory, emptyProfile, triage);
    expect(result.reason).toBe('triage_handoff');
    expect(result.handoff_reason).toBeTruthy();
  });

  it('includes the matched trigger phrase in the reason on keyword_match', () => {
    const profile = { escalation: { triggers: ['refund'] } } as unknown as BusinessProfileDto;
    const result = svc.check('I want a refund now', noHistory, profile, makeTriage());
    expect(result.reason).toBe('keyword_match');
    expect(result.matched_trigger).toBe('refund');
    expect(result.handoff_reason).toContain('refund');
  });

  it('surfaces a reason for max_turns_exceeded', () => {
    const profile = { escalation: { max_turns: 2 } } as unknown as BusinessProfileDto;
    const history: IncomingHistoryMessage[] = [
      { role: 'assistant', content: 'a', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'b', timestamp: '2026-01-01T00:00:01Z' },
    ];
    const result = svc.check('still stuck', history, profile, makeTriage());
    expect(result.reason).toBe('max_turns_exceeded');
    expect(result.handoff_reason).toBeTruthy();
  });

  it('surfaces a reason for negative_sentiment', () => {
    const profile = { escalation: { sentiment_threshold: 'negative' } } as unknown as BusinessProfileDto;
    const triage = makeTriage({ sentiment: 'very_negative' });
    const result = svc.check('you are useless', noHistory, profile, triage);
    expect(result.reason).toBe('negative_sentiment');
    expect(result.handoff_reason).toContain('very_negative');
  });
});
