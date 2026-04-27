import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import type { Orderbook } from 'orderbook-match-engine';
import {
  KAFKA_TOPICS,
  type OrderCancelCommand,
  type OrderEvent,
  type OrderSubmitCommand,
  type OrderbookEvent,
  type TradeEvent,
  type UserEvent,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingEngineService } from '../matching/matching-engine.service';
import { OutboxPublisherService } from '../kafka/outbox-publisher.service';

const BP = new Decimal(10000);

type EngineTrade = {
  tradeId: number;
  sequence: number;
  makerOrderId: number;
  takerOrderId: number;
  makerSide: number;
  takerSide: number;
  tradePrice: { toString(): string };
  tradeQuantity: { toString(): string };
};

export interface SettleSubmitResult {
  order: Prisma.OrderGetPayload<{}>;
  trades: Prisma.TradeGetPayload<{}>[];
}

export interface SettleCancelResult {
  order: Prisma.OrderGetPayload<{}>;
}

/**
 * Local monotonic counter for the orderbook event seq# — restarted on
 * matcher boot. Consumers ignore the absolute value; they only use it for
 * gap detection within a single matcher generation.
 */
let orderbookSeq = 0;

/**
 * Owns the matching + settlement transaction. The API has already locked
 * funds and created the Order(OPEN) row before publishing the SUBMIT command;
 * this service runs the actual matching against the in-memory book and
 * persists trades + balance settlements + order state in one transaction.
 *
 * Cancellation: removes from the in-memory book and refunds locked balance.
 * Idempotent — already-FILLED/CANCELLED orders are a no-op.
 */
@Injectable()
export class SettlerService {
  private readonly log = new Logger(SettlerService.name);
  /** Monotonic sequence local to this process. Restarted on boot — sufficient
   *  for ordering display feeds; the canonical sequence is the Trade.id (auto-inc). */
  private localSeq = 0n;

  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingEngineService,
    private readonly outbox: OutboxPublisherService,
  ) {}

  /** Process a SUBMIT command (already serialized via p-queue by caller). */
  async settleSubmit(cmd: OrderSubmitCommand): Promise<SettleSubmitResult | null> {
    const market = await this.prisma.market.findUnique({ where: { symbol: cmd.symbol } });
    if (!market) {
      this.log.warn(`settle skip — market not found: ${cmd.symbol}`);
      return null;
    }

    // Order should exist (API created it before publishing). Re-read to get
    // the canonical row (handles slow DB replication or out-of-order arrivals).
    const order = await this.prisma.order.findUnique({ where: { id: BigInt(cmd.orderId) } });
    if (!order) {
      this.log.warn(`settle skip — order not in DB: ${cmd.orderId}`);
      return null;
    }

    // ADR-0003 §D3 — commandId mismatch means this command was synthesised
    // for a different Order than the one currently in DB. Should be impossible
    // with outbox + unique constraint, but log and skip if it happens.
    if (order.commandId && order.commandId !== cmd.commandId) {
      this.log.warn(
        `settle skip — commandId mismatch: db=${order.commandId} cmd=${cmd.commandId}`,
      );
      return null;
    }

    // If the order was already touched (e.g. duplicate command), short-circuit.
    if (order.status === 'FILLED' || order.status === 'CANCELLED') {
      this.log.debug(`settle skip — order already terminal: ${cmd.orderId}/${order.status}`);
      return null;
    }

    const book = this.matching.getEngine(cmd.symbol);
    const makerFeeRate = new Decimal(market.makerFeeBp).div(BP);
    const takerFeeRate = new Decimal(market.takerFeeBp).div(BP);
    // Stable matchId prefix for every Trade row produced by this command.
    // If the same command somehow re-enters the settler, the unique
    // constraint on Trade.matchId catches double-settlement (ADR-0003 §D5).
    const matchCtx: MatchIdContext = { commandId: cmd.commandId, matchIdx: 0 };

    const result = await this.prisma.$transaction(
      async (tx) => {
        let trades: Prisma.TradeGetPayload<{}>[] = [];
        const orderId = Number(order.id);

        if (order.type === 'LIMIT') {
          if (!order.price) throw new BadRequestException('limit order missing price');
          const res = book.add(
            orderId,
            this.matching.sideToEngine(order.side),
            order.price.toString(),
            order.leaveQty.toString(),
          );
          trades = await this.settleTrades(
            tx,
            market,
            order,
            res.trades as unknown as EngineTrade[],
            makerFeeRate,
            takerFeeRate,
            matchCtx,
          );
          const leaveQty = new Decimal(res.order.leaveQuantity.toString());
          await this.updateOrderAfterMatch(
            tx,
            order.id,
            leaveQty,
            new Decimal(order.quantity.toString()),
          );
        } else {
          trades = await this.executeMarketOrder(
            tx,
            book,
            market,
            order,
            order.side,
            new Decimal(order.quantity.toString()),
            order.userId,
            makerFeeRate,
            takerFeeRate,
            matchCtx,
          );
        }

        const persisted = await tx.order.findUnique({ where: { id: order.id } });

        // ADR-0002 — publish events via outbox INSIDE the same transaction.
        // If the process crashes between this line and the outer return, the
        // tx rolls back and no events leak. If the process crashes after
        // commit but before relay publishes, the rows wait in the outbox.
        await this.publishSubmitEvents(tx, persisted!, trades, cmd.symbol, book);

        return { order: persisted!, trades };
      },
      { isolationLevel: 'ReadCommitted', timeout: 10_000 },
    );

    return result;
  }

  /** Process a CANCEL command (already serialized via p-queue by caller). */
  async settleCancel(cmd: OrderCancelCommand): Promise<SettleCancelResult | null> {
    const order = await this.prisma.order.findUnique({ where: { id: BigInt(cmd.orderId) } });
    if (!order) {
      this.log.warn(`cancel skip — order not in DB: ${cmd.orderId}`);
      return null;
    }
    if (order.status === 'FILLED' || order.status === 'CANCELLED') {
      this.log.debug(`cancel idempotent no-op — order=${cmd.orderId} status=${order.status}`);
      return { order };
    }

    const market = await this.prisma.market.findUnique({ where: { symbol: order.market } });
    if (!market) return null;
    const book = this.matching.getEngine(order.market);

    const updated = await this.prisma.$transaction(async (tx) => {
      // Remove from in-memory book. The order may have already partially filled
      // and is sitting on the book; cancel removes the residual.
      try {
        book.cancel(Number(order.id));
      } catch (err) {
        // Already gone (fully filled before cancel arrived) — fall through to
        // refund check based on DB state.
        this.log.debug(`book.cancel skipped: ${(err as Error).message}`);
      }

      const leaveQty = new Decimal(order.leaveQty.toString());
      if (leaveQty.gt(0)) {
        if (order.side === 'BID' && order.price) {
          const releaseQuote = new Decimal(order.price.toString()).mul(leaveQty);
          await tx.wallet.update({
            where: { userId_asset: { userId: order.userId, asset: market.quoteAsset } },
            data: {
              balance: { increment: releaseQuote.toString() as unknown as Prisma.Decimal },
              locked: { decrement: releaseQuote.toString() as unknown as Prisma.Decimal },
            },
          });
        } else if (order.side === 'ASK') {
          await tx.wallet.update({
            where: { userId_asset: { userId: order.userId, asset: market.baseAsset } },
            data: {
              balance: { increment: leaveQty.toString() as unknown as Prisma.Decimal },
              locked: { decrement: leaveQty.toString() as unknown as Prisma.Decimal },
            },
          });
        }
      }

      const persisted = await tx.order.update({
        where: { id: order.id },
        data: { status: 'CANCELLED' },
      });

      // Publish cancel events via outbox in the same tx.
      await this.publishCancelEvents(tx, persisted, book);
      return persisted;
    });

    return { order: updated };
  }

  /* ───────────────── internals (lifted verbatim from former OrderService) ───────────────── */

  private async executeMarketOrder(
    tx: Prisma.TransactionClient,
    book: Orderbook,
    market: Prisma.MarketGetPayload<{}>,
    order: Prisma.OrderGetPayload<{}>,
    side: 'BID' | 'ASK',
    quantity: Decimal,
    userId: string,
    makerFeeRate: Decimal,
    takerFeeRate: Decimal,
    matchCtx: MatchIdContext,
  ) {
    const snapshot = book.getOrderbook();
    const levels = side === 'BID' ? snapshot.asks : snapshot.bids;
    let remaining = new Decimal(quantity);
    const collected: Prisma.TradeGetPayload<{}>[] = [];

    let sweepIdCounter = 0;
    const baseSweepId = Number(order.id) * 1000 + 1_000_000_000;

    for (const lvl of levels) {
      if (remaining.lte(0)) break;
      const available = new Decimal(lvl.quantity);
      const take = Decimal.min(available, remaining);
      const sweepId = baseSweepId + sweepIdCounter++;
      const sweep = book.add(
        sweepId,
        this.matching.sideToEngine(side),
        lvl.price,
        take.toString(),
      );
      const fills = await this.settleTrades(
        tx,
        market,
        order,
        sweep.trades as unknown as EngineTrade[],
        makerFeeRate,
        takerFeeRate,
        matchCtx,
      );
      collected.push(...fills);
      remaining = remaining.sub(take);
      if (new Decimal(sweep.order.leaveQuantity.toString()).gt(0)) {
        try {
          book.cancel(sweepId);
        } catch {
          /* already fully matched */
        }
      }
    }

    await this.updateOrderAfterMatch(tx, order.id, remaining, quantity);

    if (remaining.gt(0)) {
      if (side === 'ASK') {
        await tx.wallet.update({
          where: { userId_asset: { userId, asset: market.baseAsset } },
          data: {
            balance: { increment: remaining.toString() as unknown as Prisma.Decimal },
            locked: { decrement: remaining.toString() as unknown as Prisma.Decimal },
          },
        });
      }
      await tx.order.update({
        where: { id: order.id },
        data: { status: quantity.eq(remaining) ? 'CANCELLED' : 'FILLED' },
      });
    }

    return collected;
  }

  private async settleTrades(
    tx: Prisma.TransactionClient,
    market: Prisma.MarketGetPayload<{}>,
    takerOrder: Prisma.OrderGetPayload<{}>,
    trades: EngineTrade[],
    makerFeeRate: Decimal,
    takerFeeRate: Decimal,
    matchCtx: MatchIdContext,
  ) {
    const out: Prisma.TradeGetPayload<{}>[] = [];
    for (const t of trades) {
      const price = new Decimal(t.tradePrice.toString());
      const qty = new Decimal(t.tradeQuantity.toString());
      const makerOrderId = Number(t.makerOrderId);
      const maker = await tx.order.findUniqueOrThrow({
        where: { id: BigInt(makerOrderId) },
      });
      const makerFee = qty.mul(makerFeeRate);
      const takerFee = qty.mul(takerFeeRate);
      const quoteAmt = price.mul(qty);

      // matchId is deterministic across replays of the same command —
      // index increments across the entire command's trades (so MARKET
      // sweeps that produce multiple settleTrades() calls keep counting).
      const matchId = `${matchCtx.commandId}#${matchCtx.matchIdx++}`;

      const tradeRow = await tx.trade.create({
        data: {
          sequence: ++this.localSeq,
          market: market.symbol,
          price: new Prisma.Decimal(price.toString()),
          quantity: new Prisma.Decimal(qty.toString()),
          makerOrderId: BigInt(makerOrderId),
          takerOrderId: takerOrder.id,
          makerSide: maker.side,
          takerSide: takerOrder.side,
          makerUserId: maker.userId,
          takerUserId: takerOrder.userId,
          makerFee: new Prisma.Decimal(makerFee.toString()),
          takerFee: new Prisma.Decimal(takerFee.toString()),
          matchId,
        },
      });

      // Maker settlement
      if (maker.side === 'ASK') {
        await tx.wallet.update({
          where: { userId_asset: { userId: maker.userId, asset: market.baseAsset } },
          data: { locked: { decrement: qty.toString() as unknown as Prisma.Decimal } },
        });
        await this.creditWallet(
          tx,
          maker.userId,
          market.quoteAsset,
          quoteAmt.mul(new Decimal(1).sub(makerFeeRate)),
        );
      } else {
        const makerLimit = new Decimal(maker.price!.toString());
        const reserved = makerLimit.mul(qty);
        const refund = reserved.sub(quoteAmt);
        await tx.wallet.update({
          where: { userId_asset: { userId: maker.userId, asset: market.quoteAsset } },
          data: {
            locked: { decrement: reserved.toString() as unknown as Prisma.Decimal },
            balance: { increment: refund.toString() as unknown as Prisma.Decimal },
          },
        });
        await this.creditWallet(
          tx,
          maker.userId,
          market.baseAsset,
          qty.mul(new Decimal(1).sub(makerFeeRate)),
        );
      }

      // Taker settlement
      if (takerOrder.side === 'BID') {
        if (takerOrder.type === 'LIMIT' && takerOrder.price) {
          const reservedPrice = new Decimal(takerOrder.price.toString());
          const reserved = reservedPrice.mul(qty);
          const refund = reserved.sub(quoteAmt);
          await tx.wallet.update({
            where: { userId_asset: { userId: takerOrder.userId, asset: market.quoteAsset } },
            data: {
              locked: { decrement: reserved.toString() as unknown as Prisma.Decimal },
              balance: { increment: refund.toString() as unknown as Prisma.Decimal },
            },
          });
        } else {
          await tx.wallet.update({
            where: { userId_asset: { userId: takerOrder.userId, asset: market.quoteAsset } },
            data: { balance: { decrement: quoteAmt.toString() as unknown as Prisma.Decimal } },
          });
        }
        await this.creditWallet(
          tx,
          takerOrder.userId,
          market.baseAsset,
          qty.mul(new Decimal(1).sub(takerFeeRate)),
        );
      } else {
        await tx.wallet.update({
          where: { userId_asset: { userId: takerOrder.userId, asset: market.baseAsset } },
          data: { locked: { decrement: qty.toString() as unknown as Prisma.Decimal } },
        });
        await this.creditWallet(
          tx,
          takerOrder.userId,
          market.quoteAsset,
          quoteAmt.mul(new Decimal(1).sub(takerFeeRate)),
        );
      }

      const makerAfter = {
        filledQty: new Decimal(maker.filledQty.toString()).add(qty),
        leaveQty: new Decimal(maker.leaveQty.toString()).sub(qty),
      };
      await tx.order.update({
        where: { id: maker.id },
        data: {
          filledQty: new Prisma.Decimal(makerAfter.filledQty.toString()),
          leaveQty: new Prisma.Decimal(makerAfter.leaveQty.toString()),
          status: makerAfter.leaveQty.lte(0) ? 'FILLED' : 'PARTIAL',
        },
      });

      out.push(tradeRow);
    }
    return out;
  }

  private async creditWallet(
    tx: Prisma.TransactionClient,
    userId: string,
    asset: string,
    amount: Decimal,
  ) {
    const amt = new Prisma.Decimal(amount.toString());
    await tx.wallet.upsert({
      where: { userId_asset: { userId, asset } },
      update: { balance: { increment: amt } },
      create: { userId, asset, balance: amt },
    });
  }

  private async updateOrderAfterMatch(
    tx: Prisma.TransactionClient,
    orderId: bigint,
    leaveQty: Decimal,
    originalQty: Decimal,
  ) {
    const filledQty = originalQty.sub(leaveQty);
    const status = leaveQty.lte(0) ? 'FILLED' : filledQty.gt(0) ? 'PARTIAL' : 'OPEN';
    await tx.order.update({
      where: { id: orderId },
      data: {
        filledQty: new Prisma.Decimal(filledQty.toString()),
        leaveQty: new Prisma.Decimal(leaveQty.toString()),
        status,
      },
    });
  }

  /* ───────────────── outbox publishers (ADR-0002) ───────────────── */

  /**
   * Emit ORDER_ADDED + per-trade TRADE/USER_EVENT + ORDERBOOK_SNAPSHOT.
   *
   * Inside the settle transaction so:
   *   - tx commit guarantees event durability,
   *   - tx rollback cleanly discards events with the rolled-back DB state.
   *
   * Each event carries an `eventId` (UUID) so consumers using `withDedupe`
   * can collapse duplicate delivery (ADR-0003 §D4).
   */
  private async publishSubmitEvents(
    tx: Prisma.TransactionClient,
    order: Prisma.OrderGetPayload<{}>,
    trades: Prisma.TradeGetPayload<{}>[],
    symbol: string,
    book: Orderbook,
  ) {
    const orderEvt: OrderEvent = {
      v: 1,
      type: 'ORDER_ADDED',
      eventId: randomUUID(),
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
    };
    await this.outbox.publish(tx, {
      topic: KAFKA_TOPICS.ORDERS,
      key: symbol,
      payload: orderEvt,
    });

    for (const t of trades) {
      const tradeEvt: TradeEvent = {
        v: 1,
        type: 'TRADE',
        // Deterministic eventId — re-running the same command produces the
        // same matchId → same eventId → consumer dedupe still works even
        // if the relay republishes.
        eventId: t.matchId ?? randomUUID(),
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
      await this.outbox.publish(tx, {
        topic: KAFKA_TOPICS.TRADES,
        key: symbol,
        payload: tradeEvt,
      });

      const takerNotif: UserEvent = {
        v: 1,
        eventId: `${t.matchId ?? t.id.toString()}:taker`,
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
      await this.outbox.publish(tx, {
        topic: KAFKA_TOPICS.USER_EVENTS,
        key: t.takerUserId,
        payload: takerNotif,
      });

      const makerNotif: UserEvent = {
        ...takerNotif,
        eventId: `${t.matchId ?? t.id.toString()}:maker`,
        userId: t.makerUserId,
        payload: { ...takerNotif.payload, orderId: t.makerOrderId.toString() },
      };
      await this.outbox.publish(tx, {
        topic: KAFKA_TOPICS.USER_EVENTS,
        key: t.makerUserId,
        payload: makerNotif,
      });
    }

    // Post-match orderbook snapshot.
    const ob = book.getOrderbook();
    const obEvt: OrderbookEvent = {
      v: 1,
      type: 'ORDERBOOK_SNAPSHOT',
      eventId: randomUUID(),
      market: symbol,
      seq: ++orderbookSeq,
      asks: ob.asks.map((l) => ({ price: l.price, quantity: l.quantity })),
      bids: ob.bids.map((l) => ({ price: l.price, quantity: l.quantity })),
      ts: Date.now(),
    };
    await this.outbox.publish(tx, {
      topic: KAFKA_TOPICS.ORDERBOOK,
      key: symbol,
      payload: obEvt,
    });
  }

  /**
   * Emit ORDER_CANCELLED + USER_EVENT + ORDERBOOK_SNAPSHOT, all via outbox
   * inside the cancel transaction.
   */
  private async publishCancelEvents(
    tx: Prisma.TransactionClient,
    order: Prisma.OrderGetPayload<{}>,
    book: Orderbook,
  ) {
    const orderEvt: OrderEvent = {
      v: 1,
      type: 'ORDER_CANCELLED',
      eventId: randomUUID(),
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
    };
    await this.outbox.publish(tx, {
      topic: KAFKA_TOPICS.ORDERS,
      key: order.market,
      payload: orderEvt,
    });

    const userEvt: UserEvent = {
      v: 1,
      eventId: randomUUID(),
      userId: order.userId,
      type: 'ORDER_CANCELLED',
      payload: {
        orderId: order.id.toString(),
        market: order.market,
      },
      ts: Date.now(),
    };
    await this.outbox.publish(tx, {
      topic: KAFKA_TOPICS.USER_EVENTS,
      key: order.userId,
      payload: userEvt,
    });

    const ob = book.getOrderbook();
    const obEvt: OrderbookEvent = {
      v: 1,
      type: 'ORDERBOOK_SNAPSHOT',
      eventId: randomUUID(),
      market: order.market,
      seq: ++orderbookSeq,
      asks: ob.asks.map((l) => ({ price: l.price, quantity: l.quantity })),
      bids: ob.bids.map((l) => ({ price: l.price, quantity: l.quantity })),
      ts: Date.now(),
    };
    await this.outbox.publish(tx, {
      topic: KAFKA_TOPICS.ORDERBOOK,
      key: order.market,
      payload: obEvt,
    });
  }
}

/**
 * Mutable counter passed through the settle pipeline so MARKET sweeps
 * (multiple settleTrades calls) generate strictly-increasing matchIds.
 */
interface MatchIdContext {
  readonly commandId: string;
  matchIdx: number;
}
