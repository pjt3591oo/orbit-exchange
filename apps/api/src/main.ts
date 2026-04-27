// IMPORTANT: tracing must be initialised BEFORE any module that wraps a
// library we want auto-instrumented (HTTP / prisma / kafkajs / ioredis).
// Keep these two lines at the very top of the file.
import { tracing } from '@orbit/observability';
tracing.startTracing('orbit-api');

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { metrics, metricsHandler, makeHealthHandler } from '@orbit/observability';

async function bootstrap() {
  metrics.bindMetrics('orbit-api');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: process.env.API_CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });

  // /metrics + /health BEFORE the global /api prefix so they sit at root.
  // Helmet's CSP can break Prometheus scrapes (it sets default-src none on text/plain),
  // but our metricsHandler sends Content-Type: text/plain and no inline scripts so we're fine.
  const httpAdapter = app.getHttpAdapter().getInstance();
  httpAdapter.get('/metrics', metricsHandler);
  httpAdapter.get('/health', makeHealthHandler());

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${port}`);
}

bootstrap();
