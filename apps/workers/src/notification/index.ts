import Redis from 'ioredis';
import { PublishCommand } from '@aws-sdk/client-sns';
import { CONSUMER_GROUPS, KAFKA_TOPICS, type UserEvent } from '@orbit/shared';
import { withDedupe, withKafkaContext, withRetryPolicy } from '@orbit/observability';
import { getKafka } from '../lib/kafka';
import { sns } from '../lib/aws';
import { childLogger } from '../lib/logger';

const log = childLogger('notification');
const WORKER = 'notification';
/**
 * Dedupe TTL — chosen to cover Kafka rebalance + outbox relay re-publish
 * windows (ADR-0003 §D4). 1h is well beyond either, with negligible Redis
 * memory cost.
 */
const DEDUPE_TTL_SEC = 3_600;

/**
 * Consumes user-events Kafka topic and fans them out to AWS SNS.
 * SNS in turn dispatches to email/SMS/Mobile push subscribers.
 * Per-user ordering is preserved via the userId partition key upstream.
 *
 * Reliability stack on this worker:
 *   - withKafkaContext: trace-context propagation (producer→consumer link)
 *   - withRetryPolicy: 2 inflight attempts → retry-30s topic on transient
 *     errors → DLQ on permanent. SNS down for 30 minutes? main consumer
 *     keeps moving; bad messages cycle through retry-30s.
 *   - withDedupe: collapse outbox-relay duplicate publishes into one SNS
 *     call so a user doesn't get the same notification twice.
 */
export async function runNotification() {
  const topicArn = process.env.USER_EVENTS_SNS_TOPIC_ARN;
  if (!topicArn) {
    log.warn('USER_EVENTS_SNS_TOPIC_ARN not set — notifications will be logged only');
  }

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const kafka = getKafka();
  // ADR-0004 — withRetryPolicy needs its own producer to publish to the
  // retry / DLQ topics. Note: this is separate from the outbox-relay's
  // producer; we don't want a single in-flight queue to couple the two.
  const producer = kafka.producer({ idempotent: true, allowAutoTopicCreation: true });
  await producer.connect();
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.NOTIFICATION });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.USER_EVENTS, fromBeginning: false });

  await consumer.run({
    eachMessage: ({ topic, partition, message }) =>
      withKafkaContext({ worker: WORKER, topic, partition, message }, async () => {
        if (!message.value) return;
        const evt = JSON.parse(message.value.toString()) as UserEvent;

        await withRetryPolicy(
          { worker: WORKER, producer },
          { topic, partition, message },
          async () => {
            await withDedupe(redis, evt.eventId, WORKER, DEDUPE_TTL_SEC, async () => {
              if (!topicArn) {
                log.info({ evt }, 'notification (dry-run)');
                return;
              }
              try {
                await sns.send(
                  new PublishCommand({
                    TopicArn: topicArn,
                    Message: JSON.stringify(evt),
                    MessageAttributes: {
                      userId: { DataType: 'String', StringValue: evt.userId },
                      type: { DataType: 'String', StringValue: evt.type },
                    },
                  }),
                );
              } catch (err) {
                log.error({ err }, 'SNS publish failed');
                throw err; // bubble to withRetryPolicy
              }
            });
          },
        );
      }),
  });

  log.info('notification worker running');
}
