// IMPORTANT: tracing first (must precede any kafka/prisma/ioredis import).
import { tracing } from '@orbit/observability';
tracing.startTracing('orbit-matcher');

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { metrics, startOpsServer } from '@orbit/observability';
import { MatchingEngineService } from './matching/matching-engine.service';
import { PrismaService } from './prisma/prisma.service';

/**
 * Matcher process bootstrap. No HTTP for the business surface — just an
 * `ApplicationContext` that wires DI, runs the in-memory matching engine,
 * consumes order commands from Kafka, and publishes resulting events.
 *
 * EXCEPT: a tiny ops HTTP server on a separate port serves /metrics,
 * /health and /ready so Prometheus and k8s probes have something to talk
 * to. This does NOT add a NestJS HTTP adapter — it's a vanilla
 * http.createServer outside the Nest lifecycle.
 *
 * /ready (ADR-0001 §D3) only flips green after the matcher's in-memory
 * orderbooks have been replayed from DB. Until then a load balancer that
 * checks /ready won't route traffic to this pod.
 */
async function bootstrap() {
  metrics.bindMetrics('orbit-matcher');

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const matching = app.get(MatchingEngineService);
  const prisma = app.get(PrismaService);

  const opsPort = Number(process.env.MATCHER_OPS_PORT ?? 3002);
  const ops = startOpsServer({
    port: opsPort,
    health: () => ({ matchingReady: matching.isReady() }),
    // ADR-0001 §D3 — /ready aggregates the things that must be true for
    // this pod to safely receive Kafka commands and downstream traffic.
    ready: async () => {
      const matchingReady = matching.isReady();
      let dbReachable = false;
      try {
        await prisma.$queryRaw`SELECT 1`;
        dbReachable = true;
      } catch {
        dbReachable = false;
      }
      const ready = matchingReady && dbReachable;
      return {
        ready,
        details: { matchingReady, dbReachable },
      };
    },
  });
  process.once('SIGTERM', () => ops.close());
  process.once('SIGINT', () => ops.close());

  // eslint-disable-next-line no-console
  console.log('[matcher] running (kafka-driven; ops on :' + opsPort + ')');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[matcher] bootstrap failed', err);
  process.exit(1);
});
