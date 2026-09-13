import { ToolExecutorService } from './tool-executor.service';
import { ASSISTANT_TOOL_NAMES } from '../assistant/assistant-tools.registry';

function makeExecutor(): ToolExecutorService {
  return new ToolExecutorService({
    mainBackendInternalUrl: () => 'http://main:3000',
    mainBackendInternalToken: () => 'tok',
  } as any);
}

function okResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as unknown as Response;
}

const CTX = { business_id: 'biz_1', conversation_id: 'conv_1', contact_id: 'contact_1' };

describe('ToolExecutorService.execute', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns an error for an unknown tool without calling out', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const out = await makeExecutor().execute('mystery', '{}', CTX);
    expect(JSON.parse(out)).toEqual({ error: 'Unknown tool: mystery' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The digest assistant's owner tools read any transcript in the tenant. They must
  // never be reachable from the customer reply path.
  it.each(ASSISTANT_TOOL_NAMES)('rejects the owner tool %s as unknown without calling out', async (name) => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const out = await makeExecutor().execute(name, '{}', CTX);
    expect(JSON.parse(out)).toEqual({ error: `Unknown tool: ${name}` });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes order_lookup with tenant-injected body', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse({ orderRef: 'TRK1', status: 'SHIPPED' }));

    const out = await makeExecutor().execute('order_lookup', '{"order_id":"TRK1"}', CTX);

    expect(JSON.parse(out)).toEqual({ orderRef: 'TRK1', status: 'SHIPPED' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://main:3000/api/v1/internal/ai/tools/order-lookup');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ tenantId: 'biz_1', orderId: 'TRK1' });
  });

  it('routes capture_lead with server-injected conversation/contact ids', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse({ status: 'created', leadId: 'l1' }));

    const out = await makeExecutor().execute(
      'capture_lead',
      '{"name":"Priya","email":"p@x.com","notes":"wants the red shirt"}',
      CTX,
    );

    expect(JSON.parse(out)).toEqual({ status: 'created', leadId: 'l1' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://main:3000/api/v1/internal/ai/tools/capture-lead');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      tenantId: 'biz_1',          // injected, never from the LLM
      conversationId: 'conv_1',   // injected
      contactId: 'contact_1',     // injected
      name: 'Priya',
      email: 'p@x.com',
    });
  });

  it('routes place_order with server-injected conversation + channel', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse({ status: 'created', orderId: 'o1', total: 900 }));

    const out = await makeExecutor().execute(
      'place_order',
      '{"items":[{"product":"Red Shirt","variant":"Medium","quantity":2}],"customer_name":"Ram","phone":"98","address":"KTM"}',
      CTX,
    );

    expect(JSON.parse(out)).toMatchObject({ status: 'created', orderId: 'o1' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://main:3000/api/v1/internal/ai/tools/place-order');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      tenantId: 'biz_1',
      conversationId: 'conv_1',
      customerName: 'Ram',
      items: [{ product: 'Red Shirt', variant: 'Medium', quantity: 2 }],
    });
  });

  it('refuses place_order with no live conversation', async () => {
    const out = await makeExecutor().execute('place_order', '{"items":[{"product":"X"}]}', { business_id: 'biz_1' });
    expect(JSON.parse(out)).toEqual({ error: 'place_order is only available in a live conversation' });
  });

  it('refuses capture_lead with no live conversation (e.g. sandbox)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const out = await makeExecutor().execute('capture_lead', '{"name":"Priya"}', { business_id: 'biz_1' });
    expect(JSON.parse(out)).toEqual({ error: 'capture_lead is only available in a live conversation' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validates required args before calling out', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const out = await makeExecutor().execute('order_lookup', '{}', CTX);
    expect(JSON.parse(out)).toEqual({ error: 'Missing required argument: order_id' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a timeout error when the internal call aborts', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const out = await makeExecutor().execute('stock_check', '{"query":"x"}', CTX);
    expect(JSON.parse(out)).toEqual({ error: 'stock_check timed out' });
  });
});
