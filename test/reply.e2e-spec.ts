import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisClient } from '../src/cache/redis.client';
import { AppConfigService } from '../src/config/app-config.service';

const PROFILE_24_7 = {
  name: 'Fresh & More',
  description: 'Organic groceries in Kathmandu.',
  language: 'en',
  tone: {
    style: 'friendly' as const,
    persona_name: 'Sita',
    do: ['Be concise'],
    dont: ['Discuss competitors'],
  },
  hours: {
    timezone: 'Asia/Kathmandu',
    schedule: (
      ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
    ).map((day) => ({ day, open: '00:00', close: '23:59' })),
    holiday_message: 'Closed right now.',
  },
  faqs: [{ question: 'Deliver to Bhaktapur?', answer: 'Yes, same-day before 2 PM.' }],
  policies: {
    return_policy: '24h for perishables.',
    delivery_policy: 'Same-day in Kathmandu valley.',
    payment_methods: ['eSewa', 'Khalti', 'COD'],
  },
  escalation: {
    triggers: ['refund', 'manager'],
    handoff_message: 'Connecting you to a teammate.',
  },
};

const PROFILE_ALWAYS_CLOSED = {
  ...PROFILE_24_7,
  hours: { ...PROFILE_24_7.hours, schedule: [] },
};

describe('AI backend e2e (real Postgres + Redis, no LLM mock)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let redis: RedisClient;
  let token: string;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('ai/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisClient);
    const config = app.get(AppConfigService);
    token = config.internalToken();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.turnLog.deleteMany({});
    await prisma.businessProfile.deleteMany({});
    await redis.raw().flushdb();
  });

  // ───────── contract layer ─────────

  describe('contract', () => {
    it('GET /health (public, no auth) → 200 with status/uptime/version', async () => {
      const res = await http.get('/ai/v1/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok', version: expect.any(String) });
      expect(typeof res.body.uptime_s).toBe('number');
    });

    it('POST /reply without token → 401', async () => {
      await http.post('/ai/v1/reply').send({}).expect(401);
    });

    it('PUT /businesses/:id with empty body → 400', async () => {
      await http
        .put('/ai/v1/businesses/biz-x')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
    });

    it('POST /reply for unknown business_id → 404', async () => {
      const res = await http
        .post('/ai/v1/reply')
        .set('Authorization', `Bearer ${token}`)
        .send(replyBody('never-existed', 'hi'))
        .expect(404);
      expect(res.body).toMatchObject({ error: 'business_not_found', business_id: 'never-existed' });
    });
  });

  // ───────── outside_hours short-circuit ─────────

  describe('outside_hours', () => {
    it('empty schedule → status:outside_hours, no LLM call, TurnLog row with status=outside_hours', async () => {
      await http
        .put('/ai/v1/businesses/biz-closed')
        .set('Authorization', `Bearer ${token}`)
        .send(PROFILE_ALWAYS_CLOSED)
        .expect(200);

      const res = await http
        .post('/ai/v1/reply')
        .set('Authorization', `Bearer ${token}`)
        .send(replyBody('biz-closed', 'hi', { trace_id: 'tr-oh' }))
        .expect(200);

      expect(res.body.status).toBe('outside_hours');
      expect(res.body.reply).toBe('Closed right now.');
      expect(res.body.metadata.trace_id).toBe('tr-oh');
      expect(typeof res.body.metadata.latency_ms).toBe('number');

      const logs = await prisma.turnLog.findMany({ where: { business_id: 'biz-closed' } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        status: 'outside_hours',
        trace_id: 'tr-oh',
        shipped: 'Closed right now.',
        validator_pass: false,
        retry_count: 0,
      });
    });
  });

  // ───────── escalate (keyword_match) ─────────
  //
  // With OPENROUTER_API_KEY empty, triage's `authHeaders()` throws and the
  // service synthesizes a fallback Triage (intent_path: 'confusion'). The
  // escalation rule then matches the trigger word in the message body.

  describe('escalate', () => {
    it('keyword match in message → status:escalate, reason:keyword_match, no generator call, TurnLog row', async () => {
      await http
        .put('/ai/v1/businesses/biz-esc')
        .set('Authorization', `Bearer ${token}`)
        .send(PROFILE_24_7)
        .expect(200);

      const res = await http
        .post('/ai/v1/reply')
        .set('Authorization', `Bearer ${token}`)
        .send(replyBody('biz-esc', 'I want a refund please', { trace_id: 'tr-esc' }))
        .expect(200);

      expect(res.body).toMatchObject({
        status: 'escalate',
        reason: 'keyword_match',
        suggested_handoff_message: 'Connecting you to a teammate.',
      });
      expect(res.body.metadata.trace_id).toBe('tr-esc');
      expect(res.body.metadata.attempts).toBe(0);

      const logs = await prisma.turnLog.findMany({ where: { business_id: 'biz-esc' } });
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe('escalate');
      expect(logs[0].trace_id).toBe('tr-esc');
    });
  });

  // ───────── request_id dedupe ─────────

  describe('idempotency', () => {
    it('same request_id within 60s → cached response, no second TurnLog row, original trace_id preserved', async () => {
      await http
        .put('/ai/v1/businesses/biz-dedupe')
        .set('Authorization', `Bearer ${token}`)
        .send(PROFILE_24_7)
        .expect(200);

      const reqId = `dedupe-${Date.now()}`;

      const first = await http
        .post('/ai/v1/reply')
        .set('Authorization', `Bearer ${token}`)
        .send(replyBody('biz-dedupe', 'manager please', { trace_id: 'first', request_id: reqId }))
        .expect(200);
      expect(first.body.metadata.trace_id).toBe('first');

      const second = await http
        .post('/ai/v1/reply')
        .set('Authorization', `Bearer ${token}`)
        .send(
          replyBody('biz-dedupe', 'manager please', { trace_id: 'second', request_id: reqId }),
        )
        .expect(200);
      // Cache hit: second call returns the FIRST response (trace_id = 'first')
      expect(second.body.metadata.trace_id).toBe('first');
      expect(second.body).toEqual(first.body);

      // Only one TurnLog row was written
      const logs = await prisma.turnLog.findMany({ where: { business_id: 'biz-dedupe' } });
      expect(logs).toHaveLength(1);
    });
  });

  // ───────── replied (happy path) ─────────
  //
  // Requires a real OPENROUTER_API_KEY + mocked OpenRouter responses. Stubbing
  // the streaming generator end-to-end is non-trivial (the OpenRouter client
  // uses global fetch + SSE); deferred until the test harness adds undici
  // MockAgent or msw-node support. The path is exercised end-to-end via the
  // manual smoke script in docs/MAIN_BACKEND_INTEGRATION.md §10.
  it.skip('replied happy path (TODO: needs OpenRouter mock)', async () => {});
});

function replyBody(
  business_id: string,
  content: string,
  options?: { trace_id?: string; request_id?: string },
) {
  return {
    business_id,
    conversation_id: `conv-${business_id}`,
    contact_id: 'u-1',
    channel: 'web',
    message: { content, timestamp: new Date().toISOString() },
    history: [],
    options,
  };
}
