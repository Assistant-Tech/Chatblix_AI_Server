import { extractContactInfo } from './extractors';

describe('extractContactInfo — address inference (W10)', () => {
  it('does NOT store a bare city mention as address', () => {
    const out = extractContactInfo('I am in Kathmandu, do you deliver?');
    expect(out.location).toBe('Kathmandu');
    expect(out.address).toBeUndefined();
  });

  it('does NOT treat a delivery question mentioning a city as an address', () => {
    const out = extractContactInfo('can you send to pokhara');
    expect(out.address).toBeUndefined();
  });

  it('DOES capture an address when real street cues are present', () => {
    const out = extractContactInfo('deliver to house no 24, Baneshwor tole, near the temple');
    expect(out.address).toContain('Baneshwor');
  });

  it('DOES capture an address on a ward/house-number cue', () => {
    const out = extractContactInfo('ward-5, my building is the tall one');
    expect(out.address).toBeTruthy();
  });

  it('still extracts phone and email regardless of address logic', () => {
    const out = extractContactInfo('call me on 9812345678 or a@b.com');
    expect(out.phone).toBe('9812345678');
    expect(out.email).toBe('a@b.com');
  });
});
