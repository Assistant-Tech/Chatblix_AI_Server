import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Chatblix Unified Inbox — LLM Pipeline API')
    .setDescription(
      [
        'Three-stage LLM pipeline (Triage → Generator → Validator with one retry) for the Chatblix unified inbox.',
        '',
        '- `POST /api/chat/stream` streams the reply as Server-Sent Events (recommended for live chat UIs).',
        '- `POST /api/chat` returns the final reply as a single JSON payload.',
        '- `GET /api/health` and `GET /api/health/pipeline` expose readiness and in-process metrics.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addTag('chat', 'Pipeline chat endpoints')
    .addTag('health', 'Service health and pipeline metrics')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });

  const config = app.get(AppConfigService);
  const port = config.port();

  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`chatblix nest-backend listening on http://localhost:${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/api/docs`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', e);
  process.exit(1);
});
