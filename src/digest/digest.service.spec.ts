import { DigestService, buildFallbackDigest } from './digest.service';
import type { DigestRequestDto, DigestStats } from '../common/types/digest.dto';

/**
 * The digest path skips triage and the validator on purpose — it is an internal
 * summary, not a customer-facing reply. These tests pin the two behaviours that
 * matter downstream: the result is always the structured
 * `{ summary, attentionItems }` shape main-backend renders from, and a broken
 * LLM call degrades to a stats-only digest instead of failing the job.
 */

function statsWith(overrides: Partial<DigestStats> = {}): DigestStats {
  return {
    window: { start: '2026-09-08T09:00:00.000Z', end: '2026-09-08T10:00:00.000Z', hours: 1 },
    conversations: { active: 12, created: 4, resolved: 3 },
    handling: { aiHandled: 9, humanHandled: 3, aiReplies: 20, escalations: 2, handoffs: 2 },
    channels: [{ channel: 'WHATSAPP', inbound: 18, outbound: 20, conversations: 10 }],
    captured: { leads: 2, orders: 1, orderValue: 3400 },
    backlog: {
      unassignedOverThreshold: 2,
      unassignedThresholdMinutes: 30,
      oldestUnresolvedHandoffMinutes: 95,
      pending: 3,
      stuck: [{ conversationId: 'c1', title: 'Sunita Rai', channel: 'WHATSAPP', waitingMinutes: 95, reason: 'Order change request.' }],
    },
    ...overrides,
  };
}

function requestWith(stats: DigestStats = statsWith()): DigestRequestDto {
  return {
    business_id: 'tenant-1',
    business_name: 'Himalayan Skincare',
    language: 'en',
    window: stats.window,
    stats,
    options: { trace_id: 'trace-1', request_id: 'req-1' },
  };
}

function buildService(generateDigest: jest.Mock) {
  const generator = { generateDigest } as any;
  const metrics = { bump: jest.fn() } as any;
  return { service: new DigestService(generator, metrics), metrics };
}

describe('DigestService', () => {
  it('returns the generator output as a structured result', async () => {
    const generateDigest = jest.fn().mockResolvedValue({
      summary: 'Busy hour on WhatsApp.',
      attentionItems: ['Sunita Rai has been waiting 95 minutes.'],
      model: 'anthropic/claude-haiku-4.5',
      tokensIn: 900,
      tokensOut: 120,
    });
    const { service } = buildService(generateDigest);

    const result = await service.handle(requestWith());

    expect(result.summary).toBe('Busy hour on WhatsApp.');
    expect(result.attentionItems).toEqual(['Sunita Rai has been waiting 95 minutes.']);
    expect(result.meta.model).toBe('anthropic/claude-haiku-4.5');
    expect(result.meta.tokensIn).toBe(900);
    expect(result.meta.fallbackUsed).toBe(false);
    expect(result.meta.traceId).toBe('trace-1');
  });

  it('caps attention items at five so the digest stays glanceable', async () => {
    const generateDigest = jest.fn().mockResolvedValue({
      summary: 'Lots going on.',
      attentionItems: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      model: 'm',
      tokensIn: null,
      tokensOut: null,
    });
    const { service } = buildService(generateDigest);

    const result = await service.handle(requestWith());

    expect(result.attentionItems).toHaveLength(5);
  });

  it('falls back to a stats-only digest when generation fails, instead of failing the job', async () => {
    const generateDigest = jest.fn().mockRejectedValue(new Error('digest_unparseable_output'));
    const { service, metrics } = buildService(generateDigest);

    const result = await service.handle(requestWith());

    expect(result.meta.fallbackUsed).toBe(true);
    expect(result.meta.model).toBeNull();
    expect(result.summary).toContain('12 conversations');
    // The numbers that drive owner action must survive the fallback.
    expect(result.attentionItems.join(' ')).toContain('unassigned for over 30 minutes');
    expect(metrics.bump).toHaveBeenCalledWith('digest_fallback_used');
  });
});

describe('buildFallbackDigest', () => {
  it('names stuck conversations and the oldest unresolved handoff', () => {
    const { attentionItems } = buildFallbackDigest(requestWith());

    expect(attentionItems).toContain('The oldest unresolved AI handoff has been waiting 95 minutes.');
    expect(attentionItems.some(i => i.startsWith('Sunita Rai has been waiting 95 minutes on WHATSAPP'))).toBe(true);
  });

  it('raises nothing when the backlog is clean', () => {
    const clean = statsWith({
      backlog: {
        unassignedOverThreshold: 0,
        unassignedThresholdMinutes: 30,
        oldestUnresolvedHandoffMinutes: null,
        pending: 0,
        stuck: [],
      },
    });

    const { summary, attentionItems } = buildFallbackDigest(requestWith(clean));

    expect(attentionItems).toEqual([]);
    expect(summary).toContain('9 handled by the AI');
  });

  it('omits the captured line when nothing was captured', () => {
    const nothing = statsWith({ captured: { leads: 0, orders: 0, orderValue: 0 } });

    const { summary } = buildFallbackDigest(requestWith(nothing));

    expect(summary).not.toContain('Captured');
  });
});
