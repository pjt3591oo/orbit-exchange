import { PublishCommand } from '@aws-sdk/client-sns';
import { CONSUMER_GROUPS, KAFKA_TOPICS, type UserEvent } from '@orbit/shared';
import { getKafka } from '../lib/kafka';
import { sns } from '../lib/aws';
import { childLogger } from '../lib/logger';

const log = childLogger('notification');

/**
 * Consumes user-events Kafka topic and fans them out to AWS SNS.
 * SNS in turn dispatches to email/SMS/Mobile push subscribers.
 * Per-user ordering is preserved via the userId partition key upstream.
 */
export async function runNotification() {
  const topicArn = process.env.USER_EVENTS_SNS_TOPIC_ARN;
  if (!topicArn) {
    log.warn('USER_EVENTS_SNS_TOPIC_ARN not set — notifications will be logged only');
  }

  const consumer = getKafka().consumer({ groupId: CONSUMER_GROUPS.NOTIFICATION });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.USER_EVENTS, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const evt = JSON.parse(message.value.toString()) as UserEvent;

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
      }
    },
  });

  log.info('notification worker running');
}
