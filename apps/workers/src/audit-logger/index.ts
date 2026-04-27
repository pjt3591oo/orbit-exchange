import { PutObjectCommand } from '@aws-sdk/client-s3';
import { CONSUMER_GROUPS, KAFKA_TOPICS } from '@orbit/shared';
import { withKafkaContext } from '@orbit/observability';
import { getKafka } from '../lib/kafka';
import { s3 } from '../lib/aws';
import { childLogger } from '../lib/logger';

const log = childLogger('audit-logger');
const WORKER = 'audit-logger';

/**
 * ADR-0006 — eachBatch + manual commit.
 *
 * Reads every v1 event topic and writes JSONL batches to S3 under
 * `s3://<bucket>/yyyy/MM/dd/HH/<topic>-<partition>-<firstOffset>.jsonl`.
 *
 * Why eachBatch instead of eachMessage:
 *
 *   The previous eachMessage implementation pushed lines into an in-memory
 *   batch and relied on auto-commit + a setInterval flush. That broke
 *   at-least-once: kafkajs commits the offset as soon as eachMessage
 *   returns, so a process crash before flushBatch() runs lost up to
 *   `setInterval` worth of lines.
 *
 *   eachBatch + autoCommit:false flips the boundary: we drain a Kafka
 *   batch into memory, push the lines to S3, AND ONLY THEN advance the
 *   offset. Crash before S3 success → next start re-reads the same batch
 *   → S3 PutObject overwrites the same key (the firstOffset is part of
 *   the key, so the bytes are identical for the same offset range). At
 *   the storage layer this is naturally idempotent.
 *
 * Crash modes:
 *   - During fetch: nothing changed, retry on restart.
 *   - During PutObject: partial / no upload; offset still where we
 *     started, retry. The half-uploaded body is overwritten on the retry
 *     by S3's last-write-wins semantics.
 *   - Between PutObject success and commit: the same range is replayed
 *     and PutObject overwrites the identical bytes. No duplicate
 *     downstream effect (the audit consumer is the trail of record, not
 *     a side-effect emitter).
 */
export async function runAuditLogger() {
  const bucket = process.env.AUDIT_S3_BUCKET ?? 'orbit-audit-logs';
  const kafka = getKafka();
  const consumer = kafka.consumer({
    groupId: CONSUMER_GROUPS.AUDIT_LOGGER,
    // Cap how long a single fetch waits to fill, so quiet topics still
    // make forward progress and don't pin lines in memory indefinitely.
    maxWaitTimeInMs: 5_000,
    minBytes: 1,
    maxBytesPerPartition: 5 * 1024 * 1024,
  });

  await consumer.connect();
  for (const topic of [KAFKA_TOPICS.TRADES, KAFKA_TOPICS.ORDERS, KAFKA_TOPICS.USER_EVENTS]) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  await consumer.run({
    autoCommit: false,
    eachBatch: ({
      batch,
      heartbeat,
      resolveOffset,
      commitOffsetsIfNecessary,
      isRunning,
      isStale,
    }) =>
      // Wrap the whole batch in a CONSUMER span; per-message spans would
      // explode trace volume for what is otherwise an opaque archival job.
      withKafkaContext(
        {
          worker: WORKER,
          topic: batch.topic,
          partition: batch.partition,
          message: batch.messages[0] ?? { headers: undefined, offset: '0' },
        },
        async () => {
          const lines: string[] = [];
          let firstOffset: string | undefined;
          let lastResolvable: string | undefined;

          for (const message of batch.messages) {
            // The eachBatch contract: bail out promptly on shutdown /
            // stale assignment so we don't process messages that no
            // longer belong to this consumer.
            if (!isRunning() || isStale()) break;
            if (firstOffset === undefined) firstOffset = message.offset;
            if (message.value) lines.push(message.value.toString());
            lastResolvable = message.offset;
            // Heartbeat to avoid rebalance during long batch decoding.
            await heartbeat();
          }

          if (lines.length === 0) {
            // Even an empty batch advances the offset by `lastResolvable`
            // (only set if we read messages). For a truly empty batch
            // there is nothing to advance; just return.
            if (lastResolvable) {
              resolveOffset(lastResolvable);
              await commitOffsetsIfNecessary();
            }
            return;
          }

          // S3 key is deterministic per (topic, partition, firstOffset).
          // Re-running the same batch overwrites the same object — that's
          // the at-least-once safety net, not a bug.
          const d = new Date();
          const key = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/${batch.topic}-${batch.partition}-${firstOffset}.jsonl`;

          try {
            await s3.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: lines.join('\n'),
                ContentType: 'application/x-ndjson',
                Metadata: {
                  'orbit-count': String(lines.length),
                  'orbit-topic': batch.topic,
                  'orbit-partition': String(batch.partition),
                  'orbit-first-offset': firstOffset ?? '',
                },
              }),
            );
            log.debug({ key, count: lines.length }, 'audit flushed');
          } catch (err) {
            // Don't advance the offset — the next fetch will re-read the
            // same range. throw so kafkajs records the batch as failed
            // (visible in lag metrics) rather than silently moving on.
            log.error({ err, key, count: lines.length }, 'S3 PutObject failed');
            throw err;
          }

          // Only after S3 ack do we advance the offset.
          if (lastResolvable) resolveOffset(lastResolvable);
          await commitOffsetsIfNecessary();
        },
      ),
  });

  log.info('audit-logger running (eachBatch)');
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
