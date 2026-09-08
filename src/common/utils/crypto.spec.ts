import { safeEqual } from './crypto';

describe('safeEqual — constant-time compare without length leak (I2/I4)', () => {
  it('returns true for equal strings', () => {
    expect(safeEqual('a-32-char-internal-token-value!!', 'a-32-char-internal-token-value!!')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(safeEqual('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaab')).toBe(false);
  });

  it('returns false for different-length strings (does not throw)', () => {
    expect(safeEqual('short', 'a-much-longer-token-value-here')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
