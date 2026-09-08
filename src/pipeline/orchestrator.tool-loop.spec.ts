import { PipelineOrchestratorService } from './orchestrator.service';
import { MetricsService } from './metrics.service';
import type { ChatStreamEvent } from './openrouter.client';
import type { PipelineEvent, DoneInternalData } from '../common/types/pipeline.types';

// A stub generator whose per-call behaviour is supplied by `behaviour`, which
// receives the call index (0-based) and the input it was called with and
// returns the chunks to stream for that call.
function makeGenerator(behaviour: (callIndex: number, input: any) => ChatStreamEvent[]) {
  let calls = 0;
  return {
    calls: () => calls,
    streamGenerator: async function* (input: any): AsyncGenerator<ChatStreamEvent> {
      const idx = calls++;
      for (const chunk of behaviour(idx, input)) yield chunk;
    },
  };
}

const passingVerdict = {
  verdict: { pass: true, violations: [], metadata_valid: true, language_match: true },
  tokensIn: 0,
  tokensOut: 0,
};

function buildOrchestrator(overrides: {
  generator: any;
  toolExecutor: any;
  metrics?: MetricsService;
}) {
  const metrics = overrides.metrics ?? new MetricsService();
  const config = { maxRetries: () => 0, validateRiskyOnly: () => false } as any;
  const triage = {
    callTriage: async () => ({
      triage: { language: { detected: 'en' }, handoff_required: false } as any,
      tokensIn: 0,
      tokensOut: 0,
    }),
  } as any;
  const validator = { callValidator: async () => passingVerdict } as any;
  const cleaner = {
    clean: (s: string) => s,
    normalizeTypography: (s: string) => (s ? s.replace(/[—–]/g, '-') : s),
  } as any;
  const tone = { check: () => ({ pass: true, violations: [] }) } as any;
  const safety = { check: () => ({ pass: true, violations: [] }) } as any;
  const escalation = { check: () => ({ escalate: false }) } as any;

  return new PipelineOrchestratorService(
    config,
    triage,
    overrides.generator,
    validator,
    cleaner,
    tone,
    safety,
    escalation,
    metrics,
    overrides.toolExecutor,
  );
}

function buildInput() {
  return {
    ctx: {
      business_id: 'biz_1',
      profile: { name: 'Test', escalation: {} } as any,
      history: [],
      contact_id: 'c1',
      channel: 'web',
      trace_id: 't1',
      systemPrompt: 'sys',
    },
    message: 'Do you have red shirts in stock?',
    customerContext: {},
    priorAssistantLang: null,
    priorAgentQuestion: null,
    stalledCountIncoming: 0,
  };
}

async function drain(
  gen: AsyncGenerator<PipelineEvent>,
): Promise<{ events: PipelineEvent[]; done: DoneInternalData }> {
  const events: PipelineEvent[] = [];
  let done: DoneInternalData | undefined;
  for await (const ev of gen) {
    events.push(ev);
    if (ev.event === '_done_internal') done = ev.data as DoneInternalData;
  }
  return { events, done: done! };
}

describe('PipelineOrchestrator tool-call loop', () => {
  it('executes a tool once, then resumes generation with the result injected', async () => {
    const generator = makeGenerator((idx, input) => {
      if (idx === 0) {
        return [
          { type: 'tool_call', id: 'call_1', name: 'stock_check', arguments: '{"query":"red shirt"}' },
        ];
      }
      expect(input.toolContext).toHaveLength(2);
      expect(input.toolContext[1].role).toBe('tool');
      return [{ type: 'content', text: '<reply>Yes, 3 red shirts in stock.</reply>' }];
    });
    const toolExecutor = { execute: jest.fn(async () => JSON.stringify({ stock: 3 })) };

    const orch = buildOrchestrator({ generator, toolExecutor });
    const { done } = await drain(orch.streamTurn(buildInput() as any));

    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
    expect(toolExecutor.execute).toHaveBeenCalledWith(
      'stock_check',
      '{"query":"red shirt"}',
      expect.objectContaining({ business_id: 'biz_1' }),
    );
    expect(generator.calls()).toBe(2);
    expect(done.shipped).toContain('Yes, 3 red shirts in stock.');
    expect(done.outcome).toBe('pass_first_try');
    expect(done.tools_called).toEqual(['stock_check']);
  });

  it('discards content streamed before a tool call so it cannot leak into the final reply', async () => {
    const generator = makeGenerator((idx) => {
      if (idx === 0) {
        return [
          { type: 'content', text: 'Let me check that for you...' },
          { type: 'tool_call', id: 'call_1', name: 'stock_check', arguments: '{"query":"x"}' },
        ];
      }
      return [{ type: 'content', text: '<reply>We have 2 in stock.</reply>' }];
    });
    const toolExecutor = { execute: jest.fn(async () => '{"stock":2}') };

    const orch = buildOrchestrator({ generator, toolExecutor });
    const { done } = await drain(orch.streamTurn(buildInput() as any));

    expect(done.shipped).toContain('We have 2 in stock.');
    expect(done.shipped).not.toContain('Let me check that for you');
    expect(done.tools_called).toEqual(['stock_check']);
  });

  it('accumulates token usage from every generator pass, including the tool-call pass', async () => {
    const generator = makeGenerator((idx) => {
      if (idx === 0) {
        return [
          { type: 'tool_call', id: 'call_1', name: 'stock_check', arguments: '{"query":"x"}' },
          { type: 'usage', promptTokens: 100, completionTokens: 10 },
        ];
      }
      return [
        { type: 'content', text: '<reply>Done.</reply>' },
        { type: 'usage', promptTokens: 200, completionTokens: 50 },
      ];
    });
    const toolExecutor = { execute: jest.fn(async () => '{"stock":1}') };

    const orch = buildOrchestrator({ generator, toolExecutor });
    const { done } = await drain(orch.streamTurn(buildInput() as any));

    expect(done.tokensIn).toBe(300);
    expect(done.tokensOut).toBe(60);
  });

  it('salvages a reply delivered via a hallucinated send_message tool instead of looping on "Unknown tool"', async () => {
    const metrics = new MetricsService();
    // Mirrors the prod failure: gemini-flash-lite emits a send_message tool call
    // whose args carry reply + a JSON-string metadata, rather than <reply>/<metadata>.
    const generator = makeGenerator(() => [
      {
        type: 'tool_call',
        id: 'call_sm',
        name: 'send_message',
        arguments: JSON.stringify({
          reply: 'Hajur, Neem Face Wash NPR 450 ho.',
          metadata: JSON.stringify({ lead_score: 75, stage: 'closing' }),
        }),
      },
    ]);
    const toolExecutor = { execute: jest.fn(async () => '{}') };

    const orch = buildOrchestrator({ generator, toolExecutor, metrics });
    const { done } = await drain(orch.streamTurn(buildInput() as any));

    // The pseudo-tool must NOT be executed (no round-trip, no "Unknown tool").
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    // Exactly one generator pass — no wasted regeneration after the salvage.
    expect(generator.calls()).toBe(1);
    expect(done.shipped).toContain('Hajur, Neem Face Wash NPR 450 ho.');
    expect(done.shipped).toContain('"lead_score":75');
    expect(done.outcome).toBe('pass_first_try');
    expect(done.tools_called).toEqual(['send_message']);
    expect(metrics.snapshot().reply_tool_salvaged).toBe(1);
  });

  it('caps runaway tool calls at MAX_TOOL_ITERATIONS and forces a tools-disabled final answer', async () => {
    const metrics = new MetricsService();
    const generator = makeGenerator((_idx, input) => {
      if (input.disableTools) {
        return [{ type: 'content', text: '<reply>Here is what I found so far.</reply>' }];
      }
      return [{ type: 'tool_call', id: 'call_x', name: 'stock_check', arguments: '{"query":"x"}' }];
    });
    const toolExecutor = { execute: jest.fn(async () => JSON.stringify({ stock: 1 })) };

    const orch = buildOrchestrator({ generator, toolExecutor, metrics });
    const { done } = await drain(orch.streamTurn(buildInput() as any));

    expect(toolExecutor.execute).toHaveBeenCalledTimes(5);
    expect(metrics.snapshot().tool_iteration_cap_hit).toBe(1);
    expect(done.shipped).toContain('Here is what I found so far.');
    expect(done.tools_called).toHaveLength(5);
  });
});
