import 'reflect-metadata';

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  console.error('[uncaughtException]', err.message, err.stack);
  process.exit(1);
});

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  app.setGlobalPrefix('ai/v1');

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
      'Stateless AI pipeline worker. Consumes jobs from the ai:reply BullMQ queue. ' +
      'Profile data is read from shared Redis (written by main-backend on every save). ' +
      'GET /ai/v1/health is the only active HTTP endpoint.',
    )
    .setVersion('0.2.0')
    .addTag('health', 'Service health')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('ai/v1/docs', app, document, {
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });

  const config = app.get(AppConfigService);
  const port = config.port();

  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`chatblix ai-backend listening on http://localhost:${port}`);
  logger.log(`Swagger docs: http://localhost:${port}/ai/v1/docs`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', e);
  process.exit(1);
});
