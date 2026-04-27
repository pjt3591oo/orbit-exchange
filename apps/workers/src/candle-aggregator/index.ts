import { PrismaClient, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import {
  CANDLE_INTERVAL_SECONDS,
  CONSUMER_GROUPS,
  KAFKA_TOPICS,
  type TradeEvent,
} from '@orbit/shared';
import { withKafkaContext } from '@orbit/observability';
import { getKafka } from '../lib/kafka';
import { childLogger } from '../lib/logger';

type BucketKey = string; // `${market}:${openTimeSec}`

const log = childLogger('candle-aggregator');
const WORKER = 'candle-aggregator';

/**
 * Aggregates M1 candles in memory and upserts once per second per dirty
 * bucket. Idempotency is guaranteed by the (market, interval, openTime)
 * unique index — re-processing the same trade simply overwrites the same
 * (market, minute) row.
 */
export async function runCandleAggregator() {
  const prisma = new PrismaClient();
  const consumer = getKafka().consumer({ groupId: CONSUMER_GROUPS.CANDLE_AGGREGATOR });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.TRADES, fromBeginning: false });

  const buckets = new Map<
    BucketKey,
    { market: string; open: Decimal; high: Decimal; low: Decimal; close: Decimal; volume: Decimal; openTime: number }
  >();
  const dirty = new Set<BucketKey>();

  async function flush() {
    if (dirty.size === 0) return;
    const toFlush = [...dirty];
    dirty.clear();
    for (const key of toFlush) {
      const b = buckets.get(key);
      if (!b) continue;
      try {
        await prisma.candle.upsert({
          where: { market_interval_openTime: { market: b.market, interval: 'M1', openTime: new Date(b.openTime * 1000) } },
          update: {
            high: new Prisma.Decimal(b.high.toString()),
            low: new Prisma.Decimal(b.low.toString()),
            close: new Prisma.Decimal(b.close.toString()),
            volume: new Prisma.Decimal(b.volume.toString()),
          },
          create: {
            market: b.market,
            interval: 'M1',
            openTime: new Date(b.openTime * 1000),
            open: new Prisma.Decimal(b.open.toString()),
            high: new Prisma.Decimal(b.high.toString()),
            low: new Prisma.Decimal(b.low.toString()),
            close: new Prisma.Decimal(b.close.toString()),
            volume: new Prisma.Decimal(b.volume.toString()),
          },
        });
      } catch (err) {
        dirty.add(key);
        log.error({ err }, `candle upsert failed key=${key}`);
      }
    }
  }

  setInterval(() => { flush().catch(() => void 0); }, 1000).unref();

  await consumer.run({
    eachMessage: ({ topic, partition, message }) =>
      withKafkaContext({ worker: WORKER, topic, partition, message }, async () => {
      if (!message.value) return;
      const trade = JSON.parse(message.value.toString()) as TradeEvent;
      if (trade.type !== 'TRADE') return;

      const intervalSec = CANDLE_INTERVAL_SECONDS.M1;
      const openTime = Math.floor(trade.ts / 1000 / intervalSec) * intervalSec;
      const key = `${trade.market}:${openTime}`;
      const price = new Decimal(trade.price);
      const qty = new Decimal(trade.quantity);

      let b = buckets.get(key);
      if (!b) {
        b = {
          market: trade.market,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: new Decimal(0),
          openTime,
        };
        buckets.set(key, b);
      }
      b.high = Decimal.max(b.high, price);
      b.low = Decimal.min(b.low, price);
      b.close = price;
      b.volume = b.volume.add(qty);
      dirty.add(key);
      }),
  });

  log.info('candle-aggregator running');
}
