import { parseAgentOutput } from './parser';

const wrap = (reply: string, meta: object) =>
  `<reply>${reply}</reply><metadata>${JSON.stringify(meta)}</metadata>`;

describe('parseAgentOutput — suggested_reply_language allow-list (W13)', () => {
  it('keeps a valid language code', () => {
    const out = parseAgentOutput(wrap('hi', { suggested_reply_language: 'romanized_ne' }));
    expect(out.metadata.suggested_reply_language).toBe('romanized_ne');
  });

  it('coerces an unknown language code to en', () => {
    const out = parseAgentOutput(wrap('hi', { suggested_reply_language: 'klingon' }));
    expect(out.metadata.suggested_reply_language).toBe('en');
  });

  it('coerces a non-string language value to en', () => {
    const out = parseAgentOutput(wrap('hi', { suggested_reply_language: 42 as any }));
    expect(out.metadata.suggested_reply_language).toBe('en');
  });

  it('defaults to en when the field is absent', () => {
    const out = parseAgentOutput(wrap('hi', { stage: 'warm' }));
    expect(out.metadata.suggested_reply_language).toBe('en');
  });
});
