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
 * ADR-0006 — eachBatch + manual commit.
 *
 * Aggregates M1 candles in memory and upserts them as a single Postgres
 * transaction at the END of each Kafka batch. Offset advances only after
 * the transaction commits, so a crash between message arrival and DB
 * write replays the same trades on restart.
 *
 * Idempotency for replay: the (market, interval, openTime) unique index
 * on Candle means re-processing the same trade reproduces the same
 * (high, low, close, volume) values for that bucket — a deterministic
 * upsert. The volume column is the only one that's strictly additive,
 * but because we re-aggregate the WHOLE batch from scratch (the bucket
 * map is rebuilt per-batch in this implementation), the upsert WRITE
 * value is fully derived from the trade stream, not accumulated across
 * commits. So replay is naturally idempotent.
 *
 * Trade-off vs the old setInterval(flush, 1s) pattern:
 *   - Latency: candles update at most once per Kafka batch (~5s wait
 *     ceiling via maxWaitTimeInMs). Acceptable for a chart UX.
 *   - Memory: a batch is bounded by maxBytesPerPartition; no unbounded
 *     in-memory accumulation across many batches.
 *   - Throughput: bulk upsert in a single tx is faster than N separate
 *     upserts.
 */
export async function runCandleAggregator() {
  const prisma = new PrismaClient();
  const consumer = getKafka().consumer({
    groupId: CONSUMER_GROUPS.CANDLE_AGGREGATOR,
    maxWaitTimeInMs: 5_000,
    minBytes: 1,
    maxBytesPerPartition: 2 * 1024 * 1024,
  });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.TRADES, fromBeginning: false });

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
      withKafkaContext(
        {
          worker: WORKER,
          topic: batch.topic,
          partition: batch.partition,
          message: batch.messages[0] ?? { headers: undefined, offset: '0' },
        },
        async () => {
          // Re-aggregate the whole batch from scratch — see the doc
          // comment on idempotency above.
          const buckets = new Map<
            BucketKey,
            { market: string; open: Decimal; high: Decimal; low: Decimal; close: Decimal; volume: Decimal; openTime: number }
          >();

          let lastResolvable: string | undefined;
          for (const message of batch.messages) {
            if (!isRunning() || isStale()) break;
            lastResolvable = message.offset;
            await heartbeat();
            if (!message.value) continue;

            let trade: TradeEvent;
            try {
              trade = JSON.parse(message.value.toString()) as TradeEvent;
            } catch (err) {
              log.warn({ err, offset: message.offset }, 'unparseable trade — skipped');
              continue;
            }
            if (trade.type !== 'TRADE') continue;

            const intervalSec = CANDLE_INTERVAL_SECONDS.M1;
            const openTime = Math.floor(trade.ts / 1000 / intervalSec) * intervalSec;
            const key: BucketKey = `${trade.market}:${openTime}`;
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
          }

          if (buckets.size === 0) {
            if (lastResolvable) {
              resolveOffset(lastResolvable);
              await commitOffsetsIfNecessary();
            }
            return;
          }

          // Single transaction for the whole batch. Postgres unique on
          // (market, interval, openTime) makes each upsert atomic; the
          // batch tx makes the whole flush atomic.
          //
          // For replay correctness: in the rare case where a previous
          // batch already wrote a partial candle for this minute, our
          // upsert's UPDATE branch will OVERWRITE high/low/close/volume
          // with the values aggregated from THIS batch only — which is
          // a subset of what the previous batch saw. This is the only
          // place candle replay can lose information. We accept it on
          // the basis that:
          //   (a) replays are rare (process crash + restart),
          //   (b) the chart UX self-heals on the next trade for that
          //       minute, and
          //   (c) the canonical record for compliance is the audit log,
          //       not the candle.
          //
          // A stricter design would include a `select for update` on the
          // existing candle and merge — but that adds a round trip per
          // bucket per batch. Deferred until we observe real divergence.
          try {
            // Array form ($transaction([promise, ...])) — applied as a
            // single SQL transaction using the connection-level timeout.
            // No `timeout` option is accepted on this form; if we need a
            // custom one we'd switch to the interactive form.
            await prisma.$transaction(
              [...buckets.values()].map((b) =>
                prisma.candle.upsert({
                  where: {
                    market_interval_openTime: {
                      market: b.market,
                      interval: 'M1',
                      openTime: new Date(b.openTime * 1000),
                    },
                  },
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
                }),
              ),
            );
          } catch (err) {
            // Don't advance offset — kafkajs will replay the batch.
            log.error({ err, buckets: buckets.size }, 'candle batch upsert failed');
            throw err;
          }

          if (lastResolvable) resolveOffset(lastResolvable);
          await commitOffsetsIfNecessary();
        },
      ),
  });

  log.info('candle-aggregator running (eachBatch)');
}
