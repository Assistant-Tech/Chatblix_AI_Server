import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison that does not leak length via an early return.
 *
 * A naive `a.length !== b.length` short-circuit before `timingSafeEqual` reveals
 * the expected token's length through timing. Hashing both inputs to fixed-length
 * SHA-256 digests first means `timingSafeEqual` always compares equal-length
 * buffers, regardless of the raw input lengths.
 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}
