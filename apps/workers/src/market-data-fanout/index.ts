import Redis from 'ioredis';
import { CONSUMER_GROUPS, KAFKA_TOPICS, type TradeEvent, type OrderbookEvent } from '@orbit/shared';
import { getKafka } from '../lib/kafka';
import { childLogger } from '../lib/logger';

const log = childLogger('market-data-fanout');

/**
 * Consumes trade + orderbook Kafka topics and re-broadcasts into Redis
 * pub/sub channels that API pods subscribe to. This decouples the matching
 * hot path from WebSocket delivery — API pods can scale horizontally and
 * every pod still receives every market-data tick via Redis.
 */
export async function runMarketDataFanout() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const kafka = getKafka();
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.MARKET_DATA_FANOUT });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.TRADES, fromBeginning: false });
  await consumer.subscribe({ topic: KAFKA_TOPICS.ORDERBOOK, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      const evt = JSON.parse(message.value.toString());
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
    },
  });

  log.info('market-data-fanout running');
}
