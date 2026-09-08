import { GeneratorService } from './generator.service';
import type { ChatStreamEvent, OpenRouterMessage } from './openrouter.client';

/**
 * I6 — output-format enforcement. The generator prefills the assistant turn with
 * `<reply>` ONLY when no tools are sent this pass, so no-commerce tenants and the
 * forced-final pass cannot leak a preamble / code-fence / double-`<reply>` (the
 * incident corruption). When tools ARE sent, prefill must be withheld so the model
 * can still call them.
 */
function buildGenerator(capture: (messages: OpenRouterMessage[], tools: unknown) => void) {
  const config = {
    generatorModel: () => 'test/model',
    generatorTimeoutMs: () => 20000,
  } as any;
  const llmClient = {
    chatStream: async function* (opts: any): AsyncGenerator<ChatStreamEvent> {
      capture(opts.messages, opts.tools);
      yield { type: 'content', text: 'Hi there!</reply><metadata>{}</metadata>' };
    },
  } as any;
  const prompts = { getGeneratorPrompt: async () => 'STATIC_PROMPT' } as any;
  const metrics = { bump: () => undefined } as any;
  return new GeneratorService(config, llmClient, prompts, metrics);
}

function ctxWith(overrides: Record<string, unknown>) {
  return {
    business_id: 'biz_1',
    trace_id: 't1',
    history: [],
    profile: { name: 'Shop', product_catalog: [], enabled_tools: [], ...overrides },
    systemPrompt: '',
  } as any;
}

async function drain(gen: AsyncGenerator<ChatStreamEvent>): Promise<void> {
  for await (const _ of gen) {
    /* consume */
  }
}

const baseInput = (ctx: any) => ({
  ctx,
  message: 'hello',
  triage: {} as any,
  feedback: null,
  customerContext: {},
});

describe('generator reply-prefill (I6)', () => {
  it('prefills <reply> as the last assistant message when the tenant has no tools', async () => {
    let captured: OpenRouterMessage[] = [];
    let capturedTools: unknown;
    const gen = buildGenerator((m, t) => {
      captured = m;
      capturedTools = t;
    });

    await drain(gen.streamGenerator(baseInput(ctxWith({ enabled_tools: [] }))));

    expect(capturedTools).toBeUndefined();
    const last = captured[captured.length - 1];
    expect(last).toEqual({ role: 'assistant', content: '<reply>' });
  });

  it('prefills on the forced-final pass (disableTools) even for a commerce tenant', async () => {
    let captured: OpenRouterMessage[] = [];
    const gen = buildGenerator((m) => {
      captured = m;
    });

    await drain(
      gen.streamGenerator({
        ...baseInput(ctxWith({ enabled_tools: ['stock_check'] })),
        disableTools: true,
      }),
    );

    const last = captured[captured.length - 1];
    expect(last).toEqual({ role: 'assistant', content: '<reply>' });
  });

  it('does NOT prefill when tools are sent (would suppress tool calls)', async () => {
    let captured: OpenRouterMessage[] = [];
    let capturedTools: any;
    const gen = buildGenerator((m, t) => {
      captured = m;
      capturedTools = t;
    });

    await drain(gen.streamGenerator(baseInput(ctxWith({ enabled_tools: ['stock_check'] }))));

    expect(Array.isArray(capturedTools)).toBe(true);
    expect(capturedTools.length).toBeGreaterThan(0);
    const last = captured[captured.length - 1];
    expect(last.role).not.toBe('assistant');
  });
});
