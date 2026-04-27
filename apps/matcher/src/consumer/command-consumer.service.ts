import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import {
  CONSUMER_GROUPS,
  KAFKA_TOPICS,
  type OrderCommand,
} from '@orbit/shared';
import { metrics, withKafkaContext } from '@orbit/observability';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { MatchingEngineService } from '../matching/matching-engine.service';
import { SettlerService } from '../settler/settler.service';
import { SnapshotService } from '../snapshot/snapshot.service';

const M = metrics.Metrics;

/**
 * Single-consumer worker for the matcher process. Subscribes to the
 * order-commands topic and dispatches each message into the per-market
 * p-queue inside MatchingEngineService, so commands for the same symbol
 * stay strictly serialized regardless of arrival order across partitions.
 *
 * Settlement events (TRADE / ORDER / ORDERBOOK / USER_EVENT) are NOT
 * published from this class — the SettlerService writes them via
 * OutboxPublisher inside the same prisma.$transaction that mutates Trade /
 * Wallet / Order rows (ADR-0002). The outbox-relay worker then publishes
 * them to Kafka. We only handle:
 *   - command consume + dispatch to per-market p-queue
 *   - the Redis snapshot refresh (read-side cache; not authoritative state)
 *   - matcher-local metrics
 */
@Injectable()
export class CommandConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CommandConsumerService.name);
  private consumer?: Consumer;

  constructor(
    private readonly kafkaProducer: KafkaProducerService,
    private readonly matching: MatchingEngineService,
    private readonly settler: SettlerService,
    private readonly snapshot: SnapshotService,
  ) {}

  async onModuleInit() {
    const kafka = this.kafkaProducer.getKafka();
    if (!kafka) {
      this.log.warn('Kafka unavailable — command consumer disabled');
      return;
    }

    this.consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.MATCHER });
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: KAFKA_TOPICS.ORDER_COMMANDS,
        fromBeginning: false,
      });
      await this.consumer.run({
        eachMessage: (payload) =>
          withKafkaContext(
            {
              worker: 'orbit.matcher',
              topic: payload.topic,
              partition: payload.partition,
              message: payload.message,
            },
            () => this.handleMessage(payload),
          ),
      });
      this.log.log(`subscribed to ${KAFKA_TOPICS.ORDER_COMMANDS}`);
    } catch (err) {
      this.log.error(`consumer init failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.consumer) {
      try {
        await this.consumer.disconnect();
      } catch {
        /* best effort */
      }
    }
  }

  private async handleMessage({ message }: EachMessagePayload) {
    if (!message.value) return;
    let cmd: OrderCommand;
    try {
      cmd = JSON.parse(message.value.toString()) as OrderCommand;
    } catch (err) {
      this.log.warn(`bad command payload: ${(err as Error).message}`);
      return;
    }

    // Serialize per market — this is the same lane the in-memory book uses,
    // so SUBMIT and CANCEL for the same symbol can never interleave.
    await this.matching.run(cmd.symbol, async () => {
      const t0 = Date.now();
      let result: 'ok' | 'noop' | 'error' = 'ok';
      let tradeCount = 0;
      try {
        if (cmd.type === 'SUBMIT') {
          const settled = await this.settler.settleSubmit(cmd);
          if (!settled) {
            result = 'noop';
            return;
          }
          tradeCount = settled.trades.length;
          for (const t of settled.trades) {
            M.matcherTradesExecuted.inc({ market: cmd.symbol, taker_side: t.takerSide });
          }
        } else if (cmd.type === 'CANCEL') {
          const settled = await this.settler.settleCancel(cmd);
          if (!settled) {
            result = 'noop';
            return;
          }
        }
        // Snapshot reflects post-match book. Throttled inside SnapshotService.
        // The Kafka ORDERBOOK_SNAPSHOT event is published by the settler via
        // outbox; this only refreshes the Redis read-side cache.
        this.snapshot.schedule(cmd.symbol);

        // Update book-depth gauge (current level counts per side).
        const ob = this.matching.getEngine(cmd.symbol).getOrderbook();
        M.matcherBookLevels.set({ market: cmd.symbol, side: 'ASK' }, ob.asks.length);
        M.matcherBookLevels.set({ market: cmd.symbol, side: 'BID' }, ob.bids.length);
      } catch (err) {
        result = 'error';
        this.log.error(
          `command failed type=${cmd.type} order=${cmd.orderId} symbol=${cmd.symbol} (trades=${tradeCount}): ${
            (err as Error).message
          }`,
        );
      } finally {
        M.matcherSettleDuration.observe(
          { symbol: cmd.symbol, cmdType: cmd.type },
          Date.now() - t0,
        );
        M.matcherCommandsConsumed.inc({ cmdType: cmd.type, result });
      }
    });
  }
}
