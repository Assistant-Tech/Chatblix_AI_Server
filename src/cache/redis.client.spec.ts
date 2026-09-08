import { redisHost } from './redis.client';

describe('redisHost — never leaks the Redis password (W2)', () => {
  it('returns host:port and omits the password', () => {
    const out = redisHost('redis://default:sup3r-secret@my-redis.internal:6379/0');
    expect(out).toBe('my-redis.internal:6379');
    expect(out).not.toContain('sup3r-secret');
  });

  it('handles URLs without credentials', () => {
    expect(redisHost('redis://localhost:6379')).toBe('localhost:6379');
  });

  it('handles rediss:// (TLS) URLs', () => {
    const out = redisHost('rediss://user:pw@cache.example.com:6380');
    expect(out).toBe('cache.example.com:6380');
    expect(out).not.toContain('pw');
  });

  it('falls back to a redacted marker on an unparseable URL', () => {
    expect(redisHost('not a url')).toBe('[redacted]');
  });
});
