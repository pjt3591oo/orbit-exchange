import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { Prisma } from '@prisma/client';
import {
  CONSUMER_GROUPS,
  KAFKA_TOPICS,
  type OrderCommand,
  type OrderEvent,
  type OrderbookEvent,
  type TradeEvent,
  type UserEvent,
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
 * After settlement, publishes downstream events (trades, orders, orderbook,
 * user-events) and updates the Redis snapshot cache.
 */
@Injectable()
export class CommandConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CommandConsumerService.name);
  private consumer?: Consumer;
  private orderbookSeq = 0;

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
      try {
        if (cmd.type === 'SUBMIT') {
          const settled = await this.settler.settleSubmit(cmd);
          if (!settled) {
            result = 'noop';
            return;
          }
          await this.publishSubmitEvents(settled.order, settled.trades, cmd.symbol);
          // Each filled trade increments the trade counter — labelled by taker side
          for (const t of settled.trades) {
            M.matcherTradesExecuted.inc({ market: cmd.symbol, taker_side: t.takerSide });
          }
        } else if (cmd.type === 'CANCEL') {
          const settled = await this.settler.settleCancel(cmd);
          if (!settled) {
            result = 'noop';
            return;
          }
          await this.publishCancelEvents(settled.order);
        }
        // Snapshot reflects post-match book. Throttled inside SnapshotService.
        this.snapshot.schedule(cmd.symbol);
        await this.publishOrderbookEvent(cmd.symbol);

        // Update book-depth gauge (current level counts per side).
        const ob = this.matching.getEngine(cmd.symbol).getOrderbook();
        M.matcherBookLevels.set({ market: cmd.symbol, side: 'ASK' }, ob.asks.length);
        M.matcherBookLevels.set({ market: cmd.symbol, side: 'BID' }, ob.bids.length);
      } catch (err) {
        result = 'error';
        this.log.error(
          `command failed type=${cmd.type} order=${cmd.orderId} symbol=${cmd.symbol}: ${
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

  /* ───────────────── event publishing ───────────────── */

  private async publishSubmitEvents(
    order: Prisma.OrderGetPayload<{}>,
    trades: Prisma.TradeGetPayload<{}>[],
    symbol: string,
  ) {
    await this.kafkaProducer.send<OrderEvent>(KAFKA_TOPICS.ORDERS, symbol, {
      v: 1,
      type: 'ORDER_ADDED',
      orderId: order.id.toString(),
      userId: order.userId,
      market: order.market,
      side: order.side,
      orderType: order.type,
      price: order.price?.toString() ?? null,
      quantity: order.quantity.toString(),
      leaveQty: order.leaveQty.toString(),
      filledQty: order.filledQty.toString(),
      status: order.status,
      ts: Date.now(),
    });

    for (const t of trades) {
      const tradeEvt: TradeEvent = {
        v: 1,
        type: 'TRADE',
        id: t.id.toString(),
        sequence: Number(t.sequence),
        market: symbol,
        price: t.price.toString(),
        quantity: t.quantity.toString(),
        makerOrderId: t.makerOrderId.toString(),
        takerOrderId: t.takerOrderId.toString(),
        makerUserId: t.makerUserId,
        takerUserId: t.takerUserId,
        makerSide: t.makerSide,
        takerSide: t.takerSide,
        ts: t.createdAt.getTime(),
      };
      await this.kafkaProducer.send<TradeEvent>(KAFKA_TOPICS.TRADES, symbol, tradeEvt);

      const userPayload: UserEvent = {
        v: 1,
        userId: t.takerUserId,
        type: 'ORDER_FILLED',
        payload: {
          orderId: t.takerOrderId.toString(),
          market: symbol,
          price: t.price.toString(),
          quantity: t.quantity.toString(),
        },
        ts: Date.now(),
      };
      await this.kafkaProducer.send<UserEvent>(
        KAFKA_TOPICS.USER_EVENTS,
        t.takerUserId,
        userPayload,
      );
      await this.kafkaProducer.send<UserEvent>(KAFKA_TOPICS.USER_EVENTS, t.makerUserId, {
        ...userPayload,
        userId: t.makerUserId,
        payload: { ...userPayload.payload, orderId: t.makerOrderId.toString() },
      });
    }
  }

  private async publishCancelEvents(order: Prisma.OrderGetPayload<{}>) {
    await this.kafkaProducer.send<OrderEvent>(KAFKA_TOPICS.ORDERS, order.market, {
      v: 1,
      type: 'ORDER_CANCELLED',
      orderId: order.id.toString(),
      userId: order.userId,
      market: order.market,
      side: order.side,
      orderType: order.type,
      price: order.price?.toString() ?? null,
      quantity: order.quantity.toString(),
      leaveQty: order.leaveQty.toString(),
      filledQty: order.filledQty.toString(),
      status: order.status,
      ts: Date.now(),
    });

    await this.kafkaProducer.send<UserEvent>(KAFKA_TOPICS.USER_EVENTS, order.userId, {
      v: 1,
      userId: order.userId,
      type: 'ORDER_CANCELLED',
      payload: {
        orderId: order.id.toString(),
        market: order.market,
      },
      ts: Date.now(),
    });
  }

  private async publishOrderbookEvent(symbol: string) {
    const book = this.matching.getEngine(symbol);
    const ob = book.getOrderbook();
    const evt: OrderbookEvent = {
      v: 1,
      type: 'ORDERBOOK_SNAPSHOT',
      market: symbol,
      seq: ++this.orderbookSeq,
      asks: ob.asks.map((l) => ({ price: l.price, quantity: l.quantity })),
      bids: ob.bids.map((l) => ({ price: l.price, quantity: l.quantity })),
      ts: Date.now(),
    };
    await this.kafkaProducer.send<OrderbookEvent>(KAFKA_TOPICS.ORDERBOOK, symbol, evt);
  }
}
