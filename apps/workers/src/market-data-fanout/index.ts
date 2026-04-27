import Redis from 'ioredis';
import { CONSUMER_GROUPS, KAFKA_TOPICS, type TradeEvent, type OrderbookEvent } from '@orbit/shared';
import { metrics, withDedupe, withKafkaContext, withRetryPolicy } from '@orbit/observability';
import { getKafka } from '../lib/kafka';
import { childLogger } from '../lib/logger';

const log = childLogger('market-data-fanout');
const M = metrics.Metrics;
const WORKER = 'market-data-fanout';
/**
 * Dedupe TTL is shorter here than for notification — fanout duplicates
 * are visible to users as duplicated rows in the trade tape, but not
 * destructive. 5 minutes covers normal rebalance / relay window.
 */
const DEDUPE_TTL_SEC = 5 * 60;

/**
 * Consumes trade + orderbook Kafka topics and re-broadcasts into Redis
 * pub/sub channels that API pods subscribe to. This decouples the matching
 * hot path from WebSocket delivery — API pods can scale horizontally and
 * every pod still receives every market-data tick via Redis.
 *
 * Reliability stack mirrors notification: kafka-context → retry-policy →
 * dedupe → handler. Redis disconnect is the most common failure mode here
 * — withRetryPolicy classifies it transient and bounces the message to
 * the retry-30s tier, freeing the main consumer to keep moving.
 */
export async function runMarketDataFanout() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const kafka = getKafka();
  const producer = kafka.producer({ idempotent: true, allowAutoTopicCreation: true });
  await producer.connect();
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.MARKET_DATA_FANOUT });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.TRADES, fromBeginning: false });
  await consumer.subscribe({ topic: KAFKA_TOPICS.ORDERBOOK, fromBeginning: false });

  await consumer.run({
    eachMessage: ({ topic, partition, message }) =>
      withKafkaContext({ worker: WORKER, topic, partition, message }, async () => {
        if (!message.value) return;
        const t0 = Date.now();
        try {
          const evt = JSON.parse(message.value.toString()) as TradeEvent | OrderbookEvent;
          await withRetryPolicy(
            { worker: WORKER, producer },
            { topic, partition, message },
            async () => {
              await withDedupe(redis, evt.eventId, WORKER, DEDUPE_TTL_SEC, async () => {
                if (topic === KAFKA_TOPICS.TRADES) {
                  const t = evt as TradeEvent;
                  await redis.publish(
                    `md:${t.market}:trade`,
                    JSON.stringify({
                      kind: 'trade',
                      data: { id: t.id, market: t.market, price: t.price, quantity: t.quantity, takerSide: t.takerSide, ts: t.ts },
                    }),
                  );
                } else if (topic === KAFKA_TOPICS.ORDERBOOK) {
                  const ob = evt as OrderbookEvent;
                  await redis.publish(
                    `md:${ob.market}:orderbook`,
                    JSON.stringify({
                      kind: 'orderbook',
                      data: { symbol: ob.market, asks: ob.asks, bids: ob.bids, ts: ob.ts },
                    }),
                  );
                }
              });
            },
          );
          M.workerMessagesProcessed.inc({ worker: WORKER, topic, result: 'ok' });
        } catch (err) {
          M.workerMessagesProcessed.inc({ worker: WORKER, topic, result: 'error' });
          log.error({ err, topic }, 'fanout handler failed');
          throw err;
        } finally {
          M.workerHandlerDuration.observe({ worker: WORKER }, Date.now() - t0);
        }
      }),
  });

  log.info('market-data-fanout running');
}
