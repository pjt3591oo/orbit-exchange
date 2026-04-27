import { PrismaClient } from '@prisma/client';
import { CompressionTypes, type Producer } from 'kafkajs';
import { metrics } from '@orbit/observability';
import { getKafka } from '../lib/kafka';
import { childLogger } from '../lib/logger';

const log = childLogger('outbox-relay');
const M = metrics.Metrics;

/**
 * Outbox relay (ADR-0002). Polls the OutboxEvent table for unprocessed
 * rows and publishes them to Kafka, then marks them processed.
 *
 * Why polling vs LISTEN/NOTIFY:
 *   - Postgres LISTEN/NOTIFY would give us lower latency, but it requires
 *     a long-lived connection and doesn't survive replication failover.
 *     Polling at 100ms is fine for our SLO (sub-second user-visible
 *     latency on order submission).
 *
 * Ordering:
 *   - Within the same partition key, we publish in createdAt order — this
 *     preserves per-symbol order for orderbook events and per-user order
 *     for user-events, which is the only ordering Kafka itself guarantees.
 *   - Across keys, we publish in id order (auto-increment) which is also
 *     createdAt-monotonic, so consumers see events in the same order they
 *     were committed.
 *
 * At-least-once:
 *   - If the relay dies between producer.send() ack and the UPDATE
 *     processedAt=NOW(), the row stays unprocessed → next tick re-sends.
 *     Consumers are responsible for dedupe via eventId (ADR-0003 §D4).
 *
 * Backpressure:
 *   - On producer error, increment attempts + lastError on the row and
 *     leave processedAt NULL. The next tick retries automatically.
 *     Persistent failure is visible via `outbox_pending_count` and
 *     `outbox_oldest_age_seconds` metrics.
 */
export async function runOutboxRelay() {
  const prisma = new PrismaClient();
  const kafka = getKafka();
  const producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 5,
    allowAutoTopicCreation: true,
  });
  await producer.connect();
  log.info('outbox relay connected to kafka');

  const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 100);
  const BATCH = Number(process.env.OUTBOX_BATCH ?? 200);
  const STATS_INTERVAL_MS = 10_000;

  let running = true;
  process.once('SIGTERM', () => {
    running = false;
  });
  process.once('SIGINT', () => {
    running = false;
  });

  // Background metric updater — pending count + oldest age.
  // Uses raw SQL because we need GROUP BY on a nullable column without
  // joining the rows themselves into the relay hot path.
  const statsTimer = setInterval(() => {
    void updateBacklogMetrics(prisma);
  }, STATS_INTERVAL_MS);
  statsTimer.unref();

  while (running) {
    try {
      const drained = await drainOnce(prisma, producer, BATCH);
      // If we drained a full batch, loop again immediately — we're behind.
      // Otherwise sleep before the next poll.
      if (drained < BATCH) await sleep(POLL_MS);
    } catch (err) {
      log.error({ err }, 'outbox relay loop crashed — backing off');
      await sleep(1_000);
    }
  }

  clearInterval(statsTimer);
  await producer.disconnect();
  await prisma.$disconnect();
  log.info('outbox relay stopped');
}

async function drainOnce(
  prisma: PrismaClient,
  producer: Producer,
  batchSize: number,
): Promise<number> {
  const events = await prisma.outboxEvent.findMany({
    where: { processedAt: null },
    orderBy: [{ id: 'asc' }],
    take: batchSize,
  });
  if (events.length === 0) return 0;

  for (const ev of events) {
    const t0 = Date.now();
    try {
      await producer.send({
        topic: ev.topic,
        compression: CompressionTypes.GZIP,
        messages: [
          {
            key: ev.key,
            value: JSON.stringify(ev.payload),
            // headers can be null/undefined/object — kafkajs is permissive.
            // We propagate `traceparent` if the producer side stored one.
            headers: toKafkaHeaders(ev.headers),
          },
        ],
      });
      const dt = Date.now() - t0;
      M.outboxRelayPublishDuration.observe({ topic: ev.topic }, dt);
      M.outboxRelayPublished.inc({ topic: ev.topic, result: 'ok' });

      // Mark processed — small post-publish window where a crash leaves
      // the row unprocessed and we'll re-publish on next start. This is
      // the at-least-once boundary and is intentional.
      await prisma.outboxEvent.update({
        where: { id: ev.id },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      const dt = Date.now() - t0;
      M.outboxRelayPublishDuration.observe({ topic: ev.topic }, dt);
      M.outboxRelayPublished.inc({ topic: ev.topic, result: 'error' });
      const msg = (err as Error).message ?? String(err);
      log.warn({ id: ev.id.toString(), topic: ev.topic, attempts: ev.attempts + 1, err: msg }, 'publish failed');
      // Don't let the per-row error abort the whole batch — record the
      // failure and move on. Next tick will retry this row.
      await prisma.outboxEvent
        .update({
          where: { id: ev.id },
          data: { attempts: { increment: 1 }, lastError: msg.slice(0, 1000) },
        })
        .catch((e) => log.error({ err: e }, 'outbox attempt-update failed'));
    }
  }

  return events.length;
}

async function updateBacklogMetrics(prisma: PrismaClient): Promise<void> {
  try {
    type Row = { topic: string; pending: bigint; oldest_seconds: number | null };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT
        "topic",
        COUNT(*)::bigint AS pending,
        EXTRACT(EPOCH FROM (NOW() - MIN("createdAt")))::float8 AS oldest_seconds
      FROM "OutboxEvent"
      WHERE "processedAt" IS NULL
      GROUP BY "topic"
    `;
    // Reset all known topic gauges to 0 so disappearing topics don't carry stale values.
    M.outboxPending.reset();
    M.outboxOldestAge.reset();
    for (const r of rows) {
      M.outboxPending.set({ topic: r.topic }, Number(r.pending));
      M.outboxOldestAge.set({ topic: r.topic }, r.oldest_seconds ?? 0);
    }
  } catch (err) {
    log.error({ err }, 'backlog metric update failed');
  }
}

function toKafkaHeaders(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
