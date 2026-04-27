import { CONSUMER_GROUPS, KAFKA_TOPICS } from '@orbit/shared';
import { withKafkaContext } from '@orbit/observability';
import { getKafka } from '../lib/kafka';
import { childLogger } from '../lib/logger';

const log = childLogger('retry-30s');
const WORKER = 'retry-30s';

/**
 * ADR-0004 §D5 — 30-second retry tier consumer.
 *
 * Reads from `orbit.retry.30s.v1`. Each message has an
 * `x-orbit-retry-after` header (epoch ms) set by withRetryPolicy when it
 * decided the original error was transient. We sleep until that
 * timestamp, then republish the message back to the original topic so
 * the original consumer gets another shot.
 *
 * Why a topic instead of an in-memory delay:
 *   The retry-30s worker is itself a kafkajs consumer, so its lag is
 *   visible in standard tooling. If the retry stage gets backed up, we
 *   see it as `orbit.retry.30s.v1` consumer lag, not as silently growing
 *   memory inside another worker.
 *
 * Why we re-publish vs invoking the original handler:
 *   Each topic's consumer owns its handler logic + dependencies. The
 *   retry worker has no idea what notification or fanout do. Bouncing
 *   the message back keeps responsibilities clean — original consumer
 *   re-reads, withRetryPolicy attempt counter is now 1+inFlight, so on
 *   another failure it goes straight to DLQ.
 */
export async function runRetry30s() {
  const kafka = getKafka();
  const producer = kafka.producer({
    idempotent: true,
    allowAutoTopicCreation: true,
  });
  await producer.connect();

  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.RETRY_30S });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.RETRY_30S, fromBeginning: false });

  await consumer.run({
    eachMessage: ({ topic, partition, message }) =>
      withKafkaContext({ worker: WORKER, topic, partition, message }, async () => {
        if (!message.value) return;
        const headers = readAllHeaders(message.headers);

        const originalTopic = headers['x-orbit-original-topic'];
        if (!originalTopic) {
          log.warn(
            { offset: message.offset },
            'retry message missing x-orbit-original-topic — dropping',
          );
          return;
        }

        const retryAfter = Number(headers['x-orbit-retry-after']);
        const wait = Number.isFinite(retryAfter) ? retryAfter - Date.now() : 0;
        if (wait > 0) {
          // Block this single message handler — kafkajs allows up to
          // session.timeout.ms (default 30s) of handler time, perfectly
          // fitting our retry delay. For longer tiers (5m, 1h) we'd
          // need a different mechanism.
          await sleep(wait);
        }

        try {
          await producer.send({
            topic: originalTopic,
            messages: [
              {
                key: message.key ?? undefined,
                value: message.value,
                // Forward all withRetryPolicy headers so the original
                // consumer's withRetryPolicy sees the bumped attempt
                // count and can escalate to DLQ on next failure.
                headers,
              },
            ],
          });
        } catch (err) {
          // Failed to republish — let kafkajs replay this message.
          log.error({ err, originalTopic }, 'retry republish failed');
          throw err;
        }
      }),
  });

  log.info('retry-30s worker running');
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
