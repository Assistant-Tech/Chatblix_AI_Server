import { OpenRouterClient, ChatStreamEvent, cachedSystemMessage } from './openrouter.client';

// Builds a fake fetch Response whose body streams the given SSE string chunks.
// Chunks are sent verbatim, so a chunk can deliberately cut a frame in half to
// exercise the client's cross-chunk line buffering.
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

function makeClient(): OpenRouterClient {
  // Only openrouterKey() is exercised by chatStream's auth headers.
  return new OpenRouterClient({ openrouterKey: () => 'test-key' } as any);
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('OpenRouterClient.chatStream — tool_call parsing', () => {
  afterEach(() => jest.restoreAllMocks());

  it('aggregates tool_call arguments split across multiple SSE frames', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"stock_check","arguments":"{\\"qu"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"ery\\":\\"red "}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"shirt\\"}"}}]}}]}\n',
      'data: [DONE]\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(streamResponse(frames));

    const client = makeClient();
    const events = await collect(
      client.chatStream({ model: 'm', system: 's', user: 'u', tools: [] as any }),
    );

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0] as Extract<ChatStreamEvent, { type: 'tool_call' }>;
    expect(tc.id).toBe('call_1');
    expect(tc.name).toBe('stock_check');
    expect(JSON.parse(tc.arguments)).toEqual({ query: 'red shirt' });
  });

  it('reassembles a frame even when a network chunk splits it mid-line', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_9","function":{"name":"stock_check","argum',
      'ents":"{\\"query\\":\\"laptop\\"}"}}]}}]}\n',
      'data: [DONE]\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(streamResponse(chunks));

    const events = await collect(
      makeClient().chatStream({ model: 'm', system: 's', user: 'u', tools: [] as any }),
    );

    const tc = events.find((e) => e.type === 'tool_call') as Extract<
      ChatStreamEvent,
      { type: 'tool_call' }
    >;
    expect(tc).toBeDefined();
    expect(tc.name).toBe('stock_check');
    expect(JSON.parse(tc.arguments)).toEqual({ query: 'laptop' });
  });

  it('emits a usage event from the trailing usage frame', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":34}}\n',
      'data: [DONE]\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(streamResponse(frames));

    const events = await collect(makeClient().chatStream({ model: 'm', system: 's', user: 'u' }));

    const usage = events.find((e) => e.type === 'usage') as Extract<
      ChatStreamEvent,
      { type: 'usage' }
    >;
    expect(usage).toBeDefined();
    expect(usage.promptTokens).toBe(120);
    expect(usage.completionTokens).toBe(34);
  });

  it('emits both tool_call and usage when a tool-call stream reports usage', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"stock_check","arguments":"{\\"query\\":\\"hat\\"}"}}]}}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":80,"completion_tokens":12}}\n',
      'data: [DONE]\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(streamResponse(frames));

    const events = await collect(
      makeClient().chatStream({ model: 'm', system: 's', user: 'u', tools: [] as any }),
    );

    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    const usage = events.find((e) => e.type === 'usage') as Extract<
      ChatStreamEvent,
      { type: 'usage' }
    >;
    expect(usage?.completionTokens).toBe(12);
  });

  it('streams plain content as content events and emits no tool_call', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n',
      'data: [DONE]\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(streamResponse(frames));

    const events = await collect(makeClient().chatStream({ model: 'm', system: 's', user: 'u' }));

    const text = events
      .filter((e) => e.type === 'content')
      .map((e) => (e as Extract<ChatStreamEvent, { type: 'content' }>).text)
      .join('');
    expect(text).toBe('Hello world');
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });
});

describe('OpenRouterClient — prompt caching', () => {
  afterEach(() => jest.restoreAllMocks());

  it('cachedSystemMessage marks the system text with an ephemeral cache breakpoint', () => {
    const msg = cachedSystemMessage('big stable prompt');
    expect(msg.role).toBe('system');
    expect(msg.content).toEqual([
      { type: 'text', text: 'big stable prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('preserves cache_control on a generator-style overrideMessages request body', async () => {
    const frames = ['data: {"choices":[{"delta":{"content":"hi"}}]}\n', 'data: [DONE]\n'];
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(streamResponse(frames));

    // Mirrors how GeneratorService hands the client a pre-built messages array.
    const messages = [
      cachedSystemMessage('GENERATOR SYSTEM PROMPT'),
      { role: 'user' as const, content: 'LATEST_MESSAGE: hi' },
    ];
    await collect(
      makeClient().chatStream({ model: 'm', system: 's', user: 'u', messages }),
    );

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
    const systemMsg = body.messages[0];
    expect(systemMsg.role).toBe('system');
    expect(systemMsg.content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(systemMsg.content[0].text).toBe('GENERATOR SYSTEM PROMPT');
  });
});
