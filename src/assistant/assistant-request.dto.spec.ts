import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AssistantStreamRequestDto } from './assistant-request.dto';

// Same options as the global pipe in main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: AssistantStreamRequestDto });

/** Shaped exactly like main-backend's AiAssistantService payload. */
function samplePayload() {
  return {
    business_id: '11111111-1111-4111-8111-111111111111',
    business_name: 'Himalayan Skincare',
    language: 'en',
    now: '2026-09-10T10:05:00.000Z',
    digest: {
      id: '22222222-2222-4222-8222-222222222222',
      status: 'READY',
      window: { start: '2026-09-10T09:00:00.000Z', end: '2026-09-10T10:00:00.000Z', hours: 1 },
      summary: 'Busy hour — 24 conversations, 18 closed out by the AI.',
      attentionItems: ['Sunita Rai has been waiting 1 hour 58 minutes on WhatsApp.'],
      stats: {
        window: { start: '2026-09-10T09:00:00.000Z', end: '2026-09-10T10:00:00.000Z', hours: 1 },
        conversations: { active: 24, created: 9, resolved: 6 },
        handling: { aiHandled: 18, humanHandled: 6, aiReplies: 41, escalations: 3, handoffs: 3 },
        channels: [{ channel: 'WHATSAPP', inbound: 38, outbound: 44, conversations: 19 }],
        captured: { leads: 4, orders: 2, orderValue: 7400 },
        backlog: {
          unassignedOverThreshold: 3,
          unassignedThresholdMinutes: 30,
          oldestUnresolvedHandoffMinutes: 118,
          pending: 5,
          stuck: [{ conversationId: 'c1', title: 'Sunita Rai', channel: 'WHATSAPP', waitingMinutes: 118, reason: null }],
        },
      },
    },
    history: [
      { role: 'user', content: 'How busy was it?' },
      { role: 'assistant', content: 'Busy: 24 conversations.' },
    ],
    message: { content: 'Who is waiting longest?' },
    options: { trace_id: '33333333-3333-4333-8333-333333333333', thread_id: '44444444-4444-4444-8444-444444444444' },
  };
}

describe('AssistantStreamRequestDto', () => {
  it("accepts main-backend's payload and keeps the stats intact", async () => {
    const payload = samplePayload();
    const dto = (await validate(payload)) as AssistantStreamRequestDto;

    expect(dto).toBeInstanceOf(AssistantStreamRequestDto);
    expect(dto.digest.stats).toEqual(payload.digest.stats);
    expect(dto.history).toHaveLength(2);
  });

  it.each([
    ['a top-level extra key', (p: any) => (p.tenantOverride = 'x')],
    ['an extra key in the digest', (p: any) => (p.digest.windowOverride = 'x')],
    ['an extra key in a history entry', (p: any) => (p.history[0].name = 'x')],
    ['a system role in history', (p: any) => (p.history[0].role = 'system')],
    ['more than 16 history entries', (p: any) => (p.history = Array.from({ length: 17 }, () => ({ role: 'user', content: 'q' })))],
    ['an over-long history entry', (p: any) => (p.history[0].content = 'x'.repeat(8001))],
    ['an empty question', (p: any) => (p.message.content = '')],
    ['an over-long question', (p: any) => (p.message.content = 'x'.repeat(2001))],
    ['a non-uuid business_id', (p: any) => (p.business_id = 'tenant-1')],
    ['a non-uuid digest id', (p: any) => (p.digest.id = '../../etc')],
    ['a missing thread id', (p: any) => delete p.options.thread_id],
  ])('rejects %s with a 400', async (_label, mutate) => {
    const payload = samplePayload();
    mutate(payload);
    await expect(validate(payload)).rejects.toBeInstanceOf(BadRequestException);
  });
});
