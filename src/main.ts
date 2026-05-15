import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  app.setGlobalPrefix('ai/v1');

  // Cap inbound JSON body size so oversized history payloads can't blow the
  // request budget. Default 256 KiB, override via MAX_REQUEST_BYTES.
  const config = app.get(AppConfigService);
  app.useBodyParser('json', { limit: config.maxRequestBytes() });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Chatblix AI Backend')
    .setDescription(
      [
        'Internal AI service called by the main backend.',
        '',
        '- `PUT /ai/v1/businesses/:id` — upsert a business profile (auth: bearer INTERNAL_API_TOKEN).',
        '- `DELETE /ai/v1/businesses/:id` — soft-delete a business profile.',
        '- `POST /ai/v1/reply` — generate a reply (or escalate / outside_hours) for one inbound message.',
        '- `POST /ai/v1/reply/stream` — SSE-streamed reply (web widgets only).',
        '- `GET /ai/v1/health` — liveness check, no auth.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addTag('businesses', 'Business profile push / delete')
    .addTag('reply', 'Pipeline reply endpoints')
    .addTag('health', 'Service health')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('ai/v1/docs', app, document, {
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });

  const port = config.port();

  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`chatblix ai-backend listening on http://localhost:${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/ai/v1/docs`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', e);
  process.exit(1);
});
