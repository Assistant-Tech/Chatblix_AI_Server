import { looksLikeLeakedReasoning, replyBodyOf } from './reasoning-leak';

describe('looksLikeLeakedReasoning', () => {
  it('flags the real-world leaked chain-of-thought we observed', () => {
    const leaked =
      'The phone number looks like it might be missing a digit (98374834 is 8 digits). ' +
      'Let me flag that before confirming. Phone ek pak check garidinu hola hajur.';
    expect(looksLikeLeakedReasoning(leaked)).toBe(true);
  });

  it('flags pipeline-internal tokens that must never appear in a reply', () => {
    expect(looksLikeLeakedReasoning('TRIAGE says stage 3, missing_fields: []')).toBe(true);
    expect(looksLikeLeakedReasoning('I should set order_confirmed: true now')).toBe(true);
    expect(looksLikeLeakedReasoning('looking at the data, no payment method was given')).toBe(true);
  });

  it('does NOT flag a normal romanized-Nepali confirmation reply', () => {
    const ok =
      'Order milyo hajur: Naam Priyanshu, Neem Face Wash NPR 450, Imadol delivery. ' +
      'Payment delivery ma garnu milcha. Aru k sodhna ke?';
    expect(looksLikeLeakedReasoning(ok)).toBe(false);
  });

  it('does NOT flag a normal English reply that contains "check"', () => {
    expect(looksLikeLeakedReasoning("Sure, let me check that for you and confirm.")).toBe(false);
    expect(looksLikeLeakedReasoning('Your order is on the way, arriving in 1-2 days.')).toBe(false);
  });

  it('handles null/empty safely', () => {
    expect(looksLikeLeakedReasoning('')).toBe(false);
    expect(looksLikeLeakedReasoning(null)).toBe(false);
    expect(looksLikeLeakedReasoning(undefined)).toBe(false);
  });
});

describe('replyBodyOf', () => {
  it('extracts the text inside <reply> tags', () => {
    expect(replyBodyOf('<reply>Hello hajur</reply><metadata>{"x":1}</metadata>')).toBe('Hello hajur');
  });

  it('strips a trailing unterminated <metadata> block', () => {
    expect(replyBodyOf('<reply>Hi</reply><metadata>{"x":1}')).toBe('Hi');
  });

  it('falls back to the cleaned candidate when there is no closing tag', () => {
    // streaming-prefix case: opening tag glued onto leaked reasoning, no close
    expect(replyBodyOf('<reply>Let me re-read the metadata')).toBe('Let me re-read the metadata');
  });
});
