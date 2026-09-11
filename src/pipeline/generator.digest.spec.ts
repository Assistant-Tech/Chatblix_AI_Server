import { GeneratorService, parseDigestOutput } from './generator.service';
import type { DigestRequestDto } from '../common/types/digest.dto';

/**
 * The digest reuses GeneratorService rather than duplicating LLM-calling logic,
 * but it must NOT reuse the reply call shape: no tools, no `<reply>` prefill, no
 * streaming — the caller needs a parsed object, so it goes through chatJson like
 * triage and the validator do.
 */

function buildGenerator(chatJson: jest.Mock) {
  const config = {
    digestModel: () => 'test/digest-model',
    generatorModel: () => 'test/generator-model',
    digestTimeoutMs: () => 20000,
  } as any;
  const llmClient = { chatJson } as any;
  const prompts = { getDigestPrompt: jest.fn().mockResolvedValue('DIGEST_PROMPT for {{BUSINESS_NAME}}') } as any;
  const metrics = { bump: jest.fn() } as any;
  return { service: new GeneratorService(config, llmClient, prompts, metrics), prompts, metrics };
}

const request: DigestRequestDto = {
  business_id: 'tenant-1',
  business_name: 'Himalayan Skincare',
  language: 'en',
  window: { start: '2026-09-08T09:00:00.000Z', end: '2026-09-08T10:00:00.000Z', hours: 1 },
  stats: {
    window: { start: '2026-09-08T09:00:00.000Z', end: '2026-09-08T10:00:00.000Z', hours: 1 },
    conversations: { active: 3, created: 1, resolved: 1 },
    handling: { aiHandled: 3, humanHandled: 0, aiReplies: 5, escalations: 0, handoffs: 0 },
    channels: [],
    captured: { leads: 0, orders: 0, orderValue: 0 },
    backlog: {
      unassignedOverThreshold: 0,
      unassignedThresholdMinutes: 30,
      oldestUnresolvedHandoffMinutes: null,
      pending: 0,
      stuck: [],
    },
  },
  options: { trace_id: 'trace-1' },
};

describe('GeneratorService.generateDigest', () => {
  it('calls chatJson with the digest model, prompt and stage — no tools, no prefill', async () => {
    const chatJson = jest.fn().mockResolvedValue({
      text: '{"summary":"Quiet hour.","attentionItems":[]}',
      raw: null,
      usage: { prompt_tokens: 700, completion_tokens: 40, cached_tokens: null },
    });
    const { service, prompts } = buildGenerator(chatJson);

    const result = await service.generateDigest(request);

    const [opts, callCtx] = chatJson.mock.calls[0];
    expect(opts.model).toBe('test/digest-model');
    expect(opts.tools).toBeUndefined();
    expect(opts.system).toContain('DIGEST_PROMPT');
    expect(opts.user).toContain('STATS:');
    expect(opts.user).toContain('LANGUAGE: en');
    expect(callCtx).toEqual({ stage: 'digest', business_id: 'tenant-1', trace_id: 'trace-1' });
    expect(prompts.getDigestPrompt).toHaveBeenCalledWith('Himalayan Skincare');

    expect(result).toEqual({
      summary: 'Quiet hour.',
      attentionItems: [],
      model: 'test/digest-model',
      tokensIn: 700,
      tokensOut: 40,
    });
  });

  it('throws on unparseable output so the caller can fall back', async () => {
    const chatJson = jest.fn().mockResolvedValue({ text: 'I am afraid I cannot do that.', raw: null, usage: null });
    const { service, metrics } = buildGenerator(chatJson);

    await expect(service.generateDigest(request)).rejects.toThrow('digest_unparseable_output');
    expect(metrics.bump).toHaveBeenCalledWith('digest_json_parse_error');
  });

  it('counts a timeout separately from other API errors', async () => {
    const chatJson = jest.fn().mockRejectedValue(Object.assign(new Error('timed out'), { kind: 'timeout' }));
    const { service, metrics } = buildGenerator(chatJson);

    await expect(service.generateDigest(request)).rejects.toThrow('timed out');
    expect(metrics.bump).toHaveBeenCalledWith('digest_timeout');
  });
});

describe('parseDigestOutput', () => {
  it('salvages a fenced JSON response', () => {
    const parsed = parseDigestOutput('```json\n{"summary":"Busy.","attentionItems":["one"]}\n```');
    expect(parsed).toEqual({ summary: 'Busy.', attentionItems: ['one'] });
  });

  it('drops non-string and blank attention items', () => {
    const parsed = parseDigestOutput('{"summary":"Busy.","attentionItems":["one","  ",null,3]}');
    expect(parsed?.attentionItems).toEqual(['one']);
  });

  it('defaults attentionItems to an empty array when the key is missing', () => {
    expect(parseDigestOutput('{"summary":"Busy."}')).toEqual({ summary: 'Busy.', attentionItems: [] });
  });

  it('returns null without a usable summary — an empty digest is worse than a fallback', () => {
    expect(parseDigestOutput('{"attentionItems":["one"]}')).toBeNull();
    expect(parseDigestOutput('{"summary":"   "}')).toBeNull();
    expect(parseDigestOutput('not json at all')).toBeNull();
  });
});
