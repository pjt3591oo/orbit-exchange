// IMPORTANT: tracing first.
import { tracing } from '@orbit/observability';
tracing.startTracing('orbit-realtime');

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { metrics, metricsHandler } from '@orbit/observability';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis/redis.module';

async function bootstrap() {
  metrics.bindMetrics('orbit-realtime');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableCors({
    origin: process.env.API_CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });
  app.enableShutdownHooks();

  const redis = app.get<Redis>(REDIS_CLIENT);

  // /metrics at root. /health is already provided by HealthController.
  const httpAdapter = app.getHttpAdapter().getInstance();
  httpAdapter.get('/metrics', metricsHandler);
  // ADR-0001 §D3 — /ready 200 only when Redis pings (the realtime
  // service relies on Redis pub/sub for fanout; without Redis it has
  // nothing to deliver).
  httpAdapter.get('/ready', async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    let redisReachable = false;
    try {
      const pong = await redis.ping();
      redisReachable = pong === 'PONG';
    } catch {
      redisReachable = false;
    }
    res.status(redisReachable ? 200 : 503).json({
      ready: redisReachable,
      details: { redisReachable },
      ts: new Date().toISOString(),
    });
  });

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
