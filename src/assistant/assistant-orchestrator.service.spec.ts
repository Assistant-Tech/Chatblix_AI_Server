import {
  AssistantAbortedError,
  AssistantError,
  AssistantOrchestratorService,
  MAX_TOOL_CALLS_PER_PASS,
  MAX_TOOL_ITERATIONS,
  type AssistantEvent,
} from './assistant-orchestrator.service';
import { ASSISTANT_TOOLS } from './assistant-tools.registry';
import { MetricsService } from '../pipeline/metrics.service';
import { LLMServerError } from '../pipeline/llm-client.service';
import type { ChatStreamEvent, ChatStreamOptions, OpenRouterMessage } from '../pipeline/openrouter.client';
import type { AssistantDoneFrame, AssistantStreamRequest } from '../common/types/assistant.dto';
import type { AssistantToolResult } from './assistant-tool-executor.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DIGEST = '22222222-2222-4222-8222-222222222222';

const REQ: AssistantStreamRequest = {
  business_id: TENANT,
  business_name: 'Himalayan Skincare',
  language: 'en',
  now: '2026-09-10T10:05:00.000Z',
  digest: {
    id: DIGEST,
    status: 'READY',
    window: { start: '2026-09-10T09:00:00.000Z', end: '2026-09-10T10:00:00.000Z', hours: 1 },
    summary: 'Busy hour.',
    attentionItems: ['Binod Neupane has been waiting 12 minutes.'],
    stats: {} as AssistantStreamRequest['digest']['stats'],
  },
  history: [
    { role: 'user', content: 'How was the hour?' },
    { role: 'assistant', content: 'Busy.' },
  ],
  message: { content: 'Who is waiting longest?' },
  options: { trace_id: '33333333-3333-4333-8333-333333333333', thread_id: '44444444-4444-4444-8444-444444444444' },
};

type Behaviour = (callIndex: number, opts: ChatStreamOptions) => ChatStreamEvent[] | Error;

function makeLlm(behaviour: Behaviour) {
  const calls: ChatStreamOptions[] = [];
  return {
    calls,
    chatStream: async function* (opts: ChatStreamOptions): AsyncGenerator<ChatStreamEvent> {
      const idx = calls.length;
      // Snapshot: the orchestrator reuses arrays between passes.
      calls.push({ ...opts, messages: JSON.parse(JSON.stringify(opts.messages)) });
      const out = behaviour(idx, opts);
      if (out instanceof Error) throw out;
      for (const chunk of out) yield chunk;
    },
  };
}

const toolCall = (id: string, name = 'list_conversations', args = '{"filter":"stuck"}'): ChatStreamEvent => ({
  type: 'tool_call',
  id,
  name,
  arguments: args,
});
const text = (t: string): ChatStreamEvent => ({ type: 'content', text: t });

function makeExecutor(content: (name: string, callNo: number) => string = (name) => JSON.stringify({ tool: name })) {
  let n = 0;
  return {
    execute: jest.fn(async (name: string, args: string): Promise<AssistantToolResult> => {
      const c = content(name, n++);
      return { content: c, ok: true, error: null, args: JSON.parse(args), durationMs: 3 };
    }),
  };
}

function build(llm: ReturnType<typeof makeLlm>, executor = makeExecutor(), turnTimeoutMs = 90_000) {
  const metrics = new MetricsService();
  const config = {
    assistantModel: () => 'anthropic/claude-haiku-4.5',
    assistantTimeoutMs: () => 30_000,
    assistantTurnTimeoutMs: () => turnTimeoutMs,
  };
  const prompts = { getAssistantPrompt: async (name: string) => `PROMPT for ${name}` };
  const orch = new AssistantOrchestratorService(config as any, llm as any, prompts as any, metrics, executor as any);
  return { orch, metrics, executor };
}

async function drain(gen: AsyncGenerator<AssistantEvent>): Promise<{ events: AssistantEvent[]; done?: AssistantDoneFrame; error?: unknown }> {
  const events: AssistantEvent[] = [];
  try {
    for await (const ev of gen) events.push(ev);
  } catch (error) {
    return { events, error };
  }
  const last = events.at(-1);
  return { events, done: last?.event === 'done' ? last.data : undefined };
}

const signal = () => new AbortController().signal;
const roles = (msgs: OpenRouterMessage[] | undefined) => (msgs ?? []).map((m) => m.role);

describe('AssistantOrchestratorService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('answers without tools: streams tokens, then done', async () => {
    const llm = makeLlm(() => [text('Binod '), text('Neupane.'), { type: 'usage', promptTokens: 900, completionTokens: 12, cachedTokens: 800 }]);
    const { orch } = build(llm);
    const { events, done } = await drain(orch.run(REQ, signal()));

    expect(events.map((e) => e.event)).toEqual(['status', 'status', 'token', 'token', 'done']);
    expect(events[0].data).toEqual({ type: 'thinking' });
    expect(events[1].data).toEqual({ type: 'typing' });
    expect(done).toMatchObject({ answer: 'Binod Neupane.', tool_calls: [], iterations: 1, capped: false, trace_id: REQ.options.trace_id });
    expect(done!.usage).toEqual({ tokensIn: 900, tokensOut: 12, cachedIn: 800 });

    // Prompt + digest cached as two system blocks; history as real turns; the time on the question.
    const [call] = llm.calls;
    expect(call.tools).toEqual([...ASSISTANT_TOOLS]);
    const system = call.messages![0].content as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0].text).toBe('PROMPT for Himalayan Skincare');
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].text.startsWith('DIGEST_CONTEXT:')).toBe(true);
    expect(system[1].text).toContain(DIGEST);
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].text).not.toContain(REQ.now);
    expect(roles(call.messages)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(call.messages![3].content).toBe('Who is waiting longest?\n\n(Asked at 2026-09-10T10:05:00.000Z)');
  });

  it('runs one tool with the server-side context and resumes with correctly shaped messages', async () => {
    const llm = makeLlm((idx) => (idx === 0 ? [text('Let me look.'), toolCall('call_1')] : [text('Sunita Rai.')]));
    const { orch, executor } = build(llm);
    const { events, done } = await drain(orch.run(REQ, signal()));

    expect(executor.execute).toHaveBeenCalledWith('list_conversations', '{"filter":"stuck"}', { tenantId: TENANT, digestId: DIGEST });
    expect(events.map((e) => e.event)).toContain('regenerate');
    expect(events).toContainEqual({ event: 'status', data: { type: 'tool', name: 'list_conversations', iteration: 1 } });

    const second = llm.calls[1].messages!;
    expect(roles(second)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool']);
    expect(second[4].tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'list_conversations', arguments: '{"filter":"stuck"}' } }]);
    expect(second[5]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', name: 'list_conversations' });

    expect(done).toMatchObject({ answer: 'Sunita Rai.', iterations: 2, capped: false });
    expect(done!.tool_calls).toEqual([
      { name: 'list_conversations', arguments: { filter: 'stuck' }, ok: true, durationMs: 3, resultChars: expect.any(Number), error: null },
    ]);
  });

  it('executes every call in a pass and returns their results in order', async () => {
    const llm = makeLlm((idx) =>
      idx === 0 ? [toolCall('a', 'list_orders', '{}'), toolCall('b', 'list_leads', '{}'), toolCall('c', 'get_digest', '{}')] : [text('Done.')],
    );
    const { orch, executor } = build(llm);
    await drain(orch.run(REQ, signal()));

    expect(executor.execute.mock.calls.map((c) => c[0])).toEqual(['list_orders', 'list_leads', 'get_digest']);
    const tools = llm.calls[1].messages!.filter((m) => m.role === 'tool');
    expect(tools.map((m) => [m.tool_call_id, m.content])).toEqual([
      ['a', '{"tool":"list_orders"}'],
      ['b', '{"tool":"list_leads"}'],
      ['c', '{"tool":"get_digest"}'],
    ]);
  });

  it(`gives every call id a result when a pass asks for more than ${MAX_TOOL_CALLS_PER_PASS}`, async () => {
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    const llm = makeLlm((idx) => (idx === 0 ? ids.map((id) => toolCall(id)) : [text('Done.')]));
    const { orch, executor } = build(llm);
    const { done } = await drain(orch.run(REQ, signal()));

    expect(executor.execute).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_PASS);
    const second = llm.calls[1].messages!;
    expect(second.find((m) => m.role === 'assistant' && m.tool_calls)?.tool_calls?.map((t) => t.id)).toEqual(ids);
    const results = second.filter((m) => m.role === 'tool');
    expect(results.map((m) => m.tool_call_id)).toEqual(ids);
    expect(results[4].content).toContain('Skipped');
    expect(results[5].content).toContain('Skipped');
    expect(done!.tool_calls.slice(4).map((a) => a.error)).toEqual(['skipped_over_call_cap', 'skipped_over_call_cap']);
  });

  it('at the cap, forces a final pass with no tools and no tool messages, the data flattened into the question', async () => {
    const llm = makeLlm((_idx, opts) => (opts.tools ? [toolCall(`call_${llm.calls.length}`)] : [text('Here is what I found.')]));
    const { orch, metrics, executor } = build(llm);
    const { done } = await drain(orch.run(REQ, signal()));

    expect(executor.execute).toHaveBeenCalledTimes(MAX_TOOL_ITERATIONS);
    expect(llm.calls).toHaveLength(MAX_TOOL_ITERATIONS + 1);
    const final = llm.calls.at(-1)!;
    expect(final.tools).toBeUndefined();
    expect(roles(final.messages)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(final.messages!.some((m) => m.tool_calls)).toBe(false);
    const question = final.messages!.at(-1)!.content as string;
    expect(question.startsWith('Who is waiting longest?')).toBe(true);
    expect(question).toContain('DATA ALREADY GATHERED');
    expect(question).toContain('{"tool":"list_conversations"}');

    expect(done).toMatchObject({ answer: 'Here is what I found.', capped: true, iterations: MAX_TOOL_ITERATIONS + 1 });
    expect(metrics.snapshot().assistant_iteration_cap_hit).toBe(1);
  });

  it('stops before the next pass when the client disconnects during a tool call', async () => {
    const controller = new AbortController();
    const llm = makeLlm((idx) => (idx === 0 ? [toolCall('call_1')] : [text('never')]));
    const executor = {
      execute: jest.fn(async (): Promise<AssistantToolResult> => {
        controller.abort();
        return { content: '{}', ok: true, error: null, args: {}, durationMs: 1 };
      }),
    };
    const { orch } = build(llm, executor as any);
    const { error } = await drain(orch.run(REQ, controller.signal));

    expect(error).toBeInstanceOf(AssistantAbortedError);
    expect(llm.calls).toHaveLength(1);
  });

  it('sums usage across passes', async () => {
    const llm = makeLlm((idx) =>
      idx === 0
        ? [toolCall('call_1'), { type: 'usage', promptTokens: 1000, completionTokens: 20, cachedTokens: 900 }]
        : [text('Ok.'), { type: 'usage', promptTokens: 1400, completionTokens: 30, cachedTokens: 900 }],
    );
    const { orch } = build(llm);
    const { done } = await drain(orch.run(REQ, signal()));

    expect(done!.usage).toEqual({ tokensIn: 2400, tokensOut: 50, cachedIn: 1800 });
  });

  it('retries a pass once on a transient error that happened before anything was streamed', async () => {
    const transient = Object.assign(new LLMServerError('upstream 503', 503), { retriable: true });
    const llm = makeLlm((idx) => (idx === 0 ? transient : [text('Recovered.')]));
    const { orch } = build(llm);
    const { done } = await drain(orch.run(REQ, signal()));

    expect(llm.calls).toHaveLength(2);
    expect(done!.answer).toBe('Recovered.');
  });

  it('does not retry a deterministic provider error', async () => {
    const badRequest = Object.assign(new LLMServerError('bad model', 400), { retriable: true });
    const llm = makeLlm(() => badRequest);
    const { orch } = build(llm);
    const { error } = await drain(orch.run(REQ, signal()));

    expect(error).toBe(badRequest);
    expect(llm.calls).toHaveLength(1);
  });

  it('enforces the turn budget between passes', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const llm = makeLlm((idx) => (idx === 0 ? [toolCall('call_1')] : [text('too late')]));
    const executor = {
      execute: jest.fn(async (): Promise<AssistantToolResult> => {
        now += 89_500; // the tool call eats almost the whole 90s turn
        return { content: '{}', ok: true, error: null, args: {}, durationMs: 89_500 };
      }),
    };
    const { orch } = build(llm, executor as any);
    const { error } = await drain(orch.run(REQ, signal()));

    expect(error).toBeInstanceOf(AssistantError);
    expect((error as AssistantError).code).toBe('budget_exceeded');
    expect(llm.calls).toHaveLength(1);
  });

  it('enforces the total tool budget: later calls are skipped and the answer is forced', async () => {
    const llm = makeLlm((idx) => (idx === 0 ? [toolCall('a'), toolCall('b'), toolCall('c')] : [text('Answer from what I have.')]));
    const executor = makeExecutor(() => JSON.stringify({ blob: 'x'.repeat(30_000) }));
    const { orch } = build(llm, executor);
    const { done } = await drain(orch.run(REQ, signal()));

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(done!.tool_calls.map((a) => a.error)).toEqual([null, null, 'skipped_over_tool_budget']);
    expect(llm.calls[1].tools).toBeUndefined();
    expect(done!.capped).toBe(true);
  });

  it("turns a call's empty arguments into '{}'", async () => {
    const llm = makeLlm((idx) => (idx === 0 ? [toolCall('call_1', 'list_leads', '')] : [text('Five leads.')]));
    const { orch, executor } = build(llm);
    await drain(orch.run(REQ, signal()));

    expect(executor.execute).toHaveBeenCalledWith('list_leads', '{}', expect.anything());
    const assistant = llm.calls[1].messages!.find((m) => m.tool_calls)!;
    expect(assistant.tool_calls![0].function.arguments).toBe('{}');
  });

  it('fails with no_answer when the final pass produces no text', async () => {
    const llm = makeLlm(() => [{ type: 'usage', promptTokens: 10, completionTokens: 0 }]);
    const { orch, metrics } = build(llm);
    const { error } = await drain(orch.run(REQ, signal()));

    expect((error as AssistantError).code).toBe('no_answer');
    expect(metrics.snapshot().assistant_no_answer).toBe(1);
  });
});
