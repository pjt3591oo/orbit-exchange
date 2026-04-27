import { PrismaClient, Prisma } from '@prisma/client';
import { CONSUMER_GROUPS, KAFKA_TOPICS } from '@orbit/shared';
import { metrics, withKafkaContext } from '@orbit/observability';
import { getKafka } from '../lib/kafka';
import { childLogger } from '../lib/logger';

const log = childLogger('dlq-monitor');
const M = metrics.Metrics;
const WORKER = 'dlq-monitor';

/**
 * ADR-0004 §D6 — DLQ → Postgres mirror.
 *
 * Subscribes to `orbit.dlq.v1` and inserts every message into the DlqEvent
 * table so the admin UI (`/dlq` page) has a queryable surface for replay
 * and dismissal. The Kafka topic itself stays the source of truth — this
 * worker is read-amplification only, never delete.
 *
 * On replay, the admin API publishes the original payload back to the
 * `originalTopic` and updates `resolvedAt + resolution = 'replayed'` on
 * the row. We never DELETE — kept for audit.
 *
 * Backlog metrics (`orbit_dlq_pending_count`, `orbit_dlq_oldest_age_seconds`)
 * are refreshed on a 10s timer so dashboards show drift even when the
 * topic is quiet.
 */
export async function runDlqMonitor() {
  const prisma = new PrismaClient();
  const consumer = getKafka().consumer({ groupId: CONSUMER_GROUPS.DLQ_MONITOR });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.DLQ, fromBeginning: false });

  // Background metric updater.
  const STATS_INTERVAL_MS = 10_000;
  const statsTimer = setInterval(() => {
    void updateBacklogMetrics(prisma);
  }, STATS_INTERVAL_MS);
  statsTimer.unref();

  await consumer.run({
    eachMessage: ({ topic, partition, message }) =>
      withKafkaContext({ worker: WORKER, topic, partition, message }, async () => {
        if (!message.value) return;

        const headers = readAllHeaders(message.headers);
        try {
          await prisma.dlqEvent.create({
            data: {
              originalTopic: headers['x-orbit-original-topic'] ?? topic,
              originalPartition: parseInt(
                headers['x-orbit-original-partition'] ?? String(partition),
                10,
              ),
              originalOffset: headers['x-orbit-original-offset'] ?? message.offset,
              payload: message.value,
              headers: headers as Prisma.InputJsonValue,
              worker: headers['x-orbit-worker'] ?? 'unknown',
              lastError: headers['x-orbit-last-error'] ?? '(no error header)',
              attempt: parseInt(headers['x-orbit-attempt'] ?? '0', 10),
            },
          });
          M.dlqMonitored.inc({
            original_topic: headers['x-orbit-original-topic'] ?? topic,
            worker: headers['x-orbit-worker'] ?? 'unknown',
          });
        } catch (err) {
          // Best-effort — if the DB is down, we re-fetch on rebalance/replay.
          // Don't throw or we'll create an infinite loop where dlq messages
          // can't even be mirrored.
          log.error({ err }, 'failed to mirror DLQ row');
        }
      }),
  });

  log.info('dlq-monitor running');
}

function readAllHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (Buffer.isBuffer(v)) out[k] = v.toString();
    else if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function updateBacklogMetrics(prisma: PrismaClient): Promise<void> {
  try {
    type Row = { pending: bigint; oldest_seconds: number | null };
    const [row] = await prisma.$queryRaw<Row[]>`
      SELECT
        COUNT(*)::bigint AS pending,
        EXTRACT(EPOCH FROM (NOW() - MIN("enqueuedAt")))::float8 AS oldest_seconds
      FROM "DlqEvent"
      WHERE "resolvedAt" IS NULL
    `;
    M.dlqPending.set(Number(row?.pending ?? 0));
    M.dlqOldestAge.set(row?.oldest_seconds ?? 0);
  } catch (err) {
    log.error({ err }, 'dlq backlog metric update failed');
  }
}
