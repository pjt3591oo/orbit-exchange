// IMPORTANT: tracing first.
import { tracing } from '@orbit/observability';
tracing.startTracing('orbit-realtime');

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { metrics, metricsHandler } from '@orbit/observability';

async function bootstrap() {
  metrics.bindMetrics('orbit-realtime');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableCors({
    origin: process.env.API_CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });
  app.enableShutdownHooks();

  // /metrics at root. /health is already provided by HealthController.
  const httpAdapter = app.getHttpAdapter().getInstance();
  httpAdapter.get('/metrics', metricsHandler);

  const port = Number(process.env.REALTIME_PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[realtime] WS + /metrics + /health listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[realtime] bootstrap failed', err);
  process.exit(1);
});
