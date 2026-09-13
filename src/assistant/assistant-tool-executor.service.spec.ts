import { AssistantToolExecutorService, MAX_TOOL_RESULT_CHARS } from './assistant-tool-executor.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DIGEST = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const CTX = { tenantId: TENANT, digestId: DIGEST };

function makeExecutor(): AssistantToolExecutorService {
  return new AssistantToolExecutorService({
    mainBackendInternalUrl: () => 'http://main:3000',
    mainBackendInternalToken: () => 'tok',
  } as any);
}

function okResponse(payload: unknown): Response {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => body } as unknown as Response;
}

function sentBody(fetchSpy: jest.SpyInstance): Record<string, unknown> {
  return JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
}

describe('AssistantToolExecutorService.execute', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['get_digest', '{"which":"previous"}', 'digest', { which: 'previous' }],
    ['list_conversations', '{"filter":"stuck","channel":"whatsapp","name_contains":" Sunita ","limit":5}', 'conversations', { filter: 'stuck', channel: 'WHATSAPP', nameContains: 'Sunita', limit: 5 }],
    ['get_conversation', `{"conversation_id":"${CONV}","message_limit":12}`, 'conversation', { conversationId: CONV, messageLimit: 12 }],
    ['list_orders', '{"status":"pending"}', 'orders', { status: 'PENDING', limit: 10 }],
    ['list_leads', '{}', 'leads', { limit: 10 }],
    ['get_period_stats', '{"metric":"automation","period":"30d"}', 'period-stats', { metric: 'automation', period: '30d' }],
  ])('routes %s to /internal/ai/assistant/%s with the context injected', async (name, args, path, expected) => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse({ fine: true }));

    const out = await makeExecutor().execute(name, args, CTX);

    expect(out).toMatchObject({ ok: true, error: null, content: '{"fine":true}' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`http://main:3000/api/v1/internal/ai/assistant/${path}`);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(sentBody(fetchSpy)).toEqual({ ...expected, tenantId: TENANT, digestId: DIGEST });
  });

  it('drops a tenant or business id the model tried to pass', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse({ leads: [] }));
    const other = '99999999-9999-4999-8999-999999999999';

    const out = await makeExecutor().execute(
      'list_leads',
      JSON.stringify({ tenantId: other, business_id: other, tenant_id: other, digestId: other, limit: 3 }),
      CTX,
    );

    const body = sentBody(fetchSpy);
    expect(body).toEqual({ limit: 3, tenantId: TENANT, digestId: DIGEST });
    expect(JSON.stringify(body)).not.toContain(other);
    expect(out.args).toEqual({ limit: 3 });
  });

  it.each(['stock_check', 'order_lookup', 'capture_lead', 'place_order', 'send_message'])('rejects the customer tool %s without calling out', async (name) => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const out = await makeExecutor().execute(name, '{}', CTX);

    expect(JSON.parse(out.content)).toEqual({ error: `Unknown tool: ${name}` });
    expect(out.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects inherited object keys as tool names', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const out = await makeExecutor().execute('toString', '{}', CTX);
    expect(out.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['list_conversations', '{"filter":'],
    ['get_conversation', `{"conversation_id":"${CONV}' OR 1=1 --"}`],
    ['get_conversation', '{}'],
    ['list_conversations', '{"filter":"everything"}'],
    ['list_conversations', '{"filter":"stuck","channel":"carrier-pigeon"}'],
    ['list_orders', '{"status":"LOST"}'],
    ['get_period_stats', '{"metric":"queue","period":"7d"}'],
    ['get_digest', '{"which":"next"}'],
  ])('returns an error without a fetch for %s(%s)', async (name, args) => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const out = await makeExecutor().execute(name, args, CTX);

    expect(out.ok).toBe(false);
    expect(JSON.parse(out.content).error).toEqual(expect.any(String));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clamps limits into range and defaults nonsense', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse({}));
    const ex = makeExecutor();

    await ex.execute('list_conversations', '{"filter":"pending","limit":500}', CTX);
    await ex.execute('list_conversations', '{"filter":"pending","limit":-3}', CTX);
    await ex.execute('get_conversation', `{"conversation_id":"${CONV}","message_limit":"lots"}`, CTX);
    await ex.execute('list_leads', '{"limit":7.9}', CTX);

    const bodies = fetchSpy.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies[0].limit).toBe(25);
    expect(bodies[1].limit).toBe(1);
    expect(bodies[2].messageLimit).toBe(20);
    expect(bodies[3].limit).toBe(7);
  });

  it('trims an over-long name filter to 80 characters', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse({}));
    await makeExecutor().execute('list_conversations', JSON.stringify({ filter: 'stuck', name_contains: 'n'.repeat(200) }), CTX);
    expect((sentBody(fetchSpy).nameContains as string).length).toBe(80);
  });

  it('never throws on a non-2xx response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as unknown as Response);
    const out = await makeExecutor().execute('list_leads', '{}', CTX);
    expect(out).toMatchObject({ ok: false, error: 'http_500' });
    expect(JSON.parse(out.content)).toEqual({ error: 'Internal API error during list_leads' });
  });

  it('never throws on a timeout', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const out = await makeExecutor().execute('list_leads', '{}', CTX);
    expect(JSON.parse(out.content)).toEqual({ error: 'list_leads timed out' });
    expect(out.ok).toBe(false);
  });

  it('never throws on a network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const out = await makeExecutor().execute('list_leads', '{}', CTX);
    expect(out.ok).toBe(false);
    expect(JSON.parse(out.content).error).toMatch(/network/);
  });

  it('reports a tool-level { error } as not ok while passing it to the model', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(okResponse({ error: 'Conversation not found.' }));
    const out = await makeExecutor().execute('get_conversation', `{"conversation_id":"${CONV}"}`, CTX);
    expect(out).toMatchObject({ ok: false, error: 'Conversation not found.', content: '{"error":"Conversation not found."}' });
  });

  it('truncates an over-long result', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(okResponse({ blob: 'z'.repeat(MAX_TOOL_RESULT_CHARS * 2) }));
    const out = await makeExecutor().execute('list_leads', '{}', CTX);
    expect(out.content.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 100);
    expect(out.content).toContain('[truncated');
  });
});
