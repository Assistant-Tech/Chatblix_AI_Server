import { TriageService } from './triage.service';
import { MetricsService } from './metrics.service';

const VALID_TRIAGE_JSON = JSON.stringify({
  language: { detected: 'en' },
  intent_path: 'greeting',
  extracted_data_delta: {},
  closing_state: {},
  buying_signal: false,
  handoff_required: false,
});

function buildInput() {
  return {
    ctx: {
      business_id: 'biz_1',
      profile: { name: 'Test' } as any,
      history: [],
      trace_id: 't1',
    },
    message: 'hi',
    customerContext: {},
    priorAssistantLang: null,
    priorAgentQuestion: null,
    stalledCountIncoming: 0,
  } as any;
}

describe('TriageService.callTriage — repair token usage is billed (W11)', () => {
  it('adds the repairJson call usage to the returned totals', async () => {
    // First chatJson call = the triage call: returns garbage (forces a repair).
    // Second call = repairJson: returns valid JSON, with its own usage.
    const chatJson = jest
      .fn()
      .mockResolvedValueOnce({
        text: 'not json at all',
        usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 0 },
      })
      .mockResolvedValueOnce({
        text: VALID_TRIAGE_JSON,
        usage: { prompt_tokens: 40, completion_tokens: 15, cached_tokens: 0 },
      });

    const config = {
      triageModel: () => 'triage-model',
      triageTimeoutMs: () => 5000,
    } as any;
    const llmClient = { chatJson } as any;
    const prompts = { getTriagePrompt: async () => 'TRIAGE PROMPT' } as any;
    const metrics = new MetricsService();

    const svc = new TriageService(config, llmClient, prompts, metrics);
    const result = await svc.callTriage(buildInput());

    expect(chatJson).toHaveBeenCalledTimes(2);
    // 100 (triage) + 40 (repair) = 140; 20 + 15 = 35.
    expect(result.tokensIn).toBe(140);
    expect(result.tokensOut).toBe(35);
    expect(metrics.snapshot().triage_self_correction_used).toBe(1);
  });

  it('does not invoke repair when the first response is already valid JSON', async () => {
    const chatJson = jest.fn().mockResolvedValueOnce({
      text: VALID_TRIAGE_JSON,
      usage: { prompt_tokens: 90, completion_tokens: 10, cached_tokens: 0 },
    });
    const config = { triageModel: () => 'm', triageTimeoutMs: () => 5000 } as any;
    const svc = new TriageService(config, { chatJson } as any, { getTriagePrompt: async () => 'P' } as any, new MetricsService());

    const result = await svc.callTriage(buildInput());
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(result.tokensIn).toBe(90);
  });
});
