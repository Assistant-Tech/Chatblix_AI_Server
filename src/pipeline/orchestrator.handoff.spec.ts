import { PipelineOrchestratorService } from './orchestrator.service';
import { MetricsService } from './metrics.service';
import type { PipelineEvent, DoneInternalData } from '../common/types/pipeline.types';

// Minimal orchestrator wired so escalation.check() short-circuits to the handoff
// fast-path. The generator/validator are never reached on this path.
function buildOrchestrator(profileEscalation: Record<string, unknown>) {
  const metrics = new MetricsService();
  const config = { maxRetries: () => 0, validateRiskyOnly: () => false } as any;
  const triage = {
    callTriage: async () => ({
      triage: { language: { detected: 'en' }, intent_path: 'complaint', handoff_required: true } as any,
      tokensIn: 0,
      tokensOut: 0,
    }),
  } as any;
  const generator = { streamGenerator: async function* () {} } as any;
  const validator = { callValidator: async () => ({ verdict: { pass: true, violations: [] } }) } as any;
  const cleaner = { clean: (s: string) => s, normalizeTypography: (s: string) => s } as any;
  const tone = { check: () => ({ pass: true, violations: [] }) } as any;
  const safety = { check: () => ({ pass: true, violations: [] }) } as any;
  const escalation = {
    check: () => ({
      escalate: true,
      reason: 'triage_handoff',
      handoff_reason: 'Customer mentioned eczema; needs a human.',
    }),
  } as any;
  const toolExecutor = { execute: jest.fn() } as any;

  const orch = new PipelineOrchestratorService(
    config, triage, generator, validator, cleaner, tone, safety, escalation, metrics, toolExecutor,
  );
  const input = {
    ctx: {
      business_id: 'biz_1',
      profile: { name: 'Test', escalation: profileEscalation } as any,
      history: [],
      contact_id: 'c1',
      channel: 'web',
      trace_id: 't1',
    },
    message: 'This is terrible, I want a refund',
    customerContext: {},
    priorAssistantLang: null,
    priorAgentQuestion: null,
    stalledCountIncoming: 0,
  };
  return { orch, input };
}

async function drain(gen: AsyncGenerator<PipelineEvent>): Promise<DoneInternalData> {
  let done: DoneInternalData | undefined;
  for await (const ev of gen) {
    if (ev.event === '_done_internal') done = ev.data as DoneInternalData;
  }
  return done!;
}

function replyBody(shipped: string): string {
  return /<reply>([\s\S]*?)<\/reply>/i.exec(shipped)?.[1] ?? '';
}

describe('PipelineOrchestrator handoff fast-path — no metadata JSON in reply (C2)', () => {
  it('emits a clean reply body with no leaked metadata JSON when handoff_message is unset', async () => {
    const { orch, input } = buildOrchestrator({}); // no handoff_message configured
    const done = await drain(orch.streamTurn(input as any));

    expect(done.outcome).toBe('escalate');
    const body = replyBody(done.shipped);
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain('{');
    expect(body).not.toContain('lead_score');
    expect(body).not.toContain('stage');
    expect(body).not.toContain('extracted_data');
  });

  it('uses the configured handoff_message verbatim when present', async () => {
    const { orch, input } = buildOrchestrator({ handoff_message: 'A colleague will reach out shortly.' });
    const done = await drain(orch.streamTurn(input as any));

    expect(replyBody(done.shipped)).toBe('A colleague will reach out shortly.');
  });

  it('carries the human-readable handoff_reason into shipped metadata and done.escalated', async () => {
    const { orch, input } = buildOrchestrator({ handoff_message: 'A colleague will reach out shortly.' });
    const done = await drain(orch.streamTurn(input as any));

    const metaJson = /<metadata>([\s\S]*?)<\/metadata>/i.exec(done.shipped)?.[1] ?? '{}';
    const meta = JSON.parse(metaJson);
    expect(meta.handoff_required).toBe(true);
    expect(meta.handoff_context).toBe('Customer mentioned eczema; needs a human.');
    // No leftover category placeholder like "escalation:triage_handoff".
    expect(meta.handoff_context).not.toContain('escalation:');
    expect(done.escalated?.handoff_reason).toBe('Customer mentioned eczema; needs a human.');
  });
});
