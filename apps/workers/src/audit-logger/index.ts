import { PutObjectCommand } from '@aws-sdk/client-s3';
import { CONSUMER_GROUPS, KAFKA_TOPICS } from '@orbit/shared';
import { getKafka } from '../lib/kafka';
import { s3 } from '../lib/aws';
import { childLogger } from '../lib/logger';

const log = childLogger('audit-logger');

/**
 * Collects every v1 event topic and writes 5-minute JSONL batches to S3
 * under s3://<bucket>/yyyy/MM/dd/HH/<topic>-<batch>.jsonl.
 * Long-term archival for compliance / forensics. Idempotency is tolerated
 * via the per-batch key (re-processing the same offset overwrites the
 * same object).
 */
export async function runAuditLogger() {
  const bucket = process.env.AUDIT_S3_BUCKET ?? 'orbit-audit-logs';
  const kafka = getKafka();
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.AUDIT_LOGGER });
  await consumer.connect();
  for (const topic of [
    KAFKA_TOPICS.TRADES,
    KAFKA_TOPICS.ORDERS,
    KAFKA_TOPICS.USER_EVENTS,
  ]) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  type Batch = { lines: string[]; firstOffset: string };
  const batches = new Map<string, Batch>(); // topic → batch
  const FLUSH_MS = Number(process.env.AUDIT_FLUSH_MS ?? 30_000);

  async function flushBatch(topic: string) {
    const batch = batches.get(topic);
    if (!batch || batch.lines.length === 0) return;
    batches.delete(topic);
    const d = new Date();
    const key = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/${topic}-${batch.firstOffset}.jsonl`;
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: batch.lines.join('\n'),
          ContentType: 'application/x-ndjson',
        }),
      );
      log.debug({ key, count: batch.lines.length }, 'audit flushed');
    } catch (err) {
      log.error({ err, key }, 'audit flush failed');
    }
  }

  setInterval(() => {
    for (const topic of batches.keys()) flushBatch(topic).catch(() => void 0);
  }, FLUSH_MS).unref();

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      let batch = batches.get(topic);
      if (!batch) {
        batch = { lines: [], firstOffset: message.offset };
        batches.set(topic, batch);
      }
      batch.lines.push(message.value.toString());
      if (batch.lines.length >= 1000) await flushBatch(topic);
    },
  });

  log.info('audit-logger running');
}

function pad(n: number) { return n.toString().padStart(2, '0'); }
