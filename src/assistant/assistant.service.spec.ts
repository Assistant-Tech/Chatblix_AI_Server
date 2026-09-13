import { AssistantService, SseWriter, toErrorFrame } from './assistant.service';
import { AssistantAbortedError, AssistantError, type AssistantEvent } from './assistant-orchestrator.service';
import { MetricsService } from '../pipeline/metrics.service';
import { LLMRateLimitError, LLMTimeoutError } from '../pipeline/llm-client.service';
import type { AssistantStreamRequest } from '../common/types/assistant.dto';

const REQ = { business_id: 'biz', options: { trace_id: 't1', thread_id: 'th1' } } as AssistantStreamRequest;

function fakeRes() {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write: jest.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      res.writableEnded = true;
    }),
  };
  return { res, writes };
}

function orchestratorYielding(events: AssistantEvent[], thenThrow?: unknown) {
  return {
    run: async function* (): AsyncGenerator<AssistantEvent> {
      for (const ev of events) yield ev;
      if (thenThrow) throw thenThrow;
    },
  };
}

const TOKEN: AssistantEvent = { event: 'token', data: { content: 'Hi' } };

describe('AssistantService.stream', () => {
  it('writes each event as an SSE frame and ends the response once', async () => {
    const { res, writes } = fakeRes();
    const service = new AssistantService(orchestratorYielding([{ event: 'status', data: { type: 'thinking' } }, TOKEN]) as any, new MetricsService());

    await service.stream(REQ, res as any, new AbortController().signal);

    expect(writes).toEqual(['event: status\ndata: {"type":"thinking"}\n\n', 'event: token\ndata: {"content":"Hi"}\n\n']);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('keeps multi-line text on one data line', async () => {
    const { res, writes } = fakeRes();
    const service = new AssistantService(orchestratorYielding([{ event: 'token', data: { content: 'a\nb' } }]) as any, new MetricsService());
    await service.stream(REQ, res as any, new AbortController().signal);
    expect(writes[0]).toBe('event: token\ndata: {"content":"a\\nb"}\n\n');
  });

  it.each([
    [new LLMTimeoutError('slow'), 'timeout', 'assistant_timeout'],
    [new AssistantError('budget_exceeded', 'turn over'), 'budget_exceeded', 'assistant_timeout'],
    [new LLMRateLimitError('429'), 'provider_error', 'assistant_provider_error'],
    [new AssistantError('no_answer', 'empty'), 'no_answer', null],
    [new TypeError('undefined is not a function'), 'internal', null],
  ] as const)('turns %s into one error frame (code %s) instead of letting it escape', async (err, code, counter) => {
    const { res, writes } = fakeRes();
    const metrics = new MetricsService();
    const service = new AssistantService(orchestratorYielding([TOKEN], err) as any, metrics);

    await expect(service.stream(REQ, res as any, new AbortController().signal)).resolves.toBeUndefined();

    const last = writes.at(-1)!;
    expect(last.startsWith('event: error\n')).toBe(true);
    const frame = JSON.parse(last.split('data: ')[1]);
    expect(frame.code).toBe(code);
    expect(frame.message).toEqual(expect.any(String));
    // Internal detail never reaches the client.
    expect(frame.message).not.toContain('undefined is not a function');
    expect(res.end).toHaveBeenCalledTimes(1);
    if (counter) expect(metrics.snapshot()[counter]).toBe(1);
  });

  it('writes nothing after the client has gone, and does not report an abort as an error', async () => {
    const { res, writes } = fakeRes();
    const metrics = new MetricsService();
    const orchestrator = {
      run: async function* (): AsyncGenerator<AssistantEvent> {
        yield TOKEN;
        res.destroyed = true; // socket closed
        yield TOKEN;
        throw new AssistantAbortedError();
      },
    };
    const service = new AssistantService(orchestrator as any, metrics);

    await service.stream(REQ, res as any, new AbortController().signal);

    expect(writes).toHaveLength(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(metrics.snapshot().assistant_aborted).toBe(1);
  });
});

describe('SseWriter', () => {
  it('ends exactly once and ignores sends after ending', () => {
    const { res } = fakeRes();
    const out = new SseWriter(res as any);
    out.end();
    out.end();
    out.send('token', { content: 'late' });
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('swallows a write that throws on a torn-down socket', () => {
    const { res } = fakeRes();
    res.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    expect(() => new SseWriter(res as any).send('token', {})).not.toThrow();
  });
});

describe('toErrorFrame', () => {
  it('never exposes the underlying message', () => {
    expect(toErrorFrame(new Error('ECONNREFUSED 10.0.0.5:5432'))).toEqual({ code: 'internal', message: expect.not.stringContaining('ECONNREFUSED') });
  });
});
