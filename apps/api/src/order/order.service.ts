import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import type { Orderbook } from 'orderbook-match-engine';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingEngineService } from '../matching/matching-engine.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { KAFKA_TOPICS } from '@orbit/shared';
import type {
  OrderEvent,
  TradeEvent,
  OrderbookEvent,
  UserEvent,
} from '@orbit/shared';
import type { CreateOrderDto } from './dto';

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

@Injectable()
export class OrderService {
  private readonly log = new Logger(OrderService.name);
  private globalSeq = 0n;

  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingEngineService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async submit(userId: string, dto: CreateOrderDto) {
    const market = await this.prisma.market.findUnique({ where: { symbol: dto.market } });
    if (!market || !market.enabled) throw new NotFoundException('market not found');
    this.validateTickStep(dto, market);

    return this.matching.run(dto.market, () => this.executeOrder(userId, dto, market));
  }

  private async executeOrder(
    userId: string,
    dto: CreateOrderDto,
    market: Prisma.MarketGetPayload<{}>,
  ) {
    const side = dto.side;
    const quantity = new Decimal(dto.quantity);
    if (quantity.lte(0)) throw new BadRequestException('quantity must be > 0');

    const limitPrice = dto.type === 'LIMIT' ? new Decimal(dto.price!) : null;
    if (dto.type === 'LIMIT' && (!limitPrice || limitPrice.lte(0))) {
      throw new BadRequestException('price required for LIMIT');
    }

    const book = this.matching.getEngine(dto.market);
    const makerFeeRate = new Decimal(market.makerFeeBp).div(BP);
    const takerFeeRate = new Decimal(market.takerFeeBp).div(BP);

    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.lockReservation(tx, userId, market, dto, quantity, limitPrice);

        const order = await tx.order.create({
          data: {
            userId,
            market: dto.market,
            side,
            type: dto.type,
            price: limitPrice ? new Prisma.Decimal(limitPrice.toString()) : null,
            quantity: new Prisma.Decimal(quantity.toString()),
            leaveQty: new Prisma.Decimal(quantity.toString()),
          },
        });
        const orderId = Number(order.id);
        let trades: Prisma.TradeGetPayload<{}>[] = [];

        if (dto.type === 'LIMIT') {
          const res = book.add(orderId, this.matching.sideToEngine(side), limitPrice!.toString(), quantity.toString());
          trades = await this.settleTrades(tx, market, order, res.trades as unknown as EngineTrade[], makerFeeRate, takerFeeRate);
          const leaveQty = new Decimal(res.order.leaveQuantity.toString());
          await this.updateOrderAfterMatch(tx, order.id, leaveQty, quantity);
        } else {
          trades = await this.executeMarketOrder(tx, book, market, order, side, quantity, userId, makerFeeRate, takerFeeRate);
        }

        const persisted = await tx.order.findUnique({ where: { id: order.id } });
        return { order: persisted!, trades };
      },
      { isolationLevel: 'ReadCommitted', timeout: 10_000 },
    );

    this.publishEvents(result.order, result.trades, dto.market).catch((err) =>
      this.log.error(`publish failed: ${(err as Error).message}`),
    );

    return this.presentOrder(result.order);
  }

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
  ) {
    // Market orders: sweep each top-of-book level by adding a matching limit
    // at that level's price. Any unmatched sweep residual is cancelled so no
    // throw-away orders stay resting.
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
      const sweep = book.add(sweepId, this.matching.sideToEngine(side), lvl.price, take.toString());
      const fills = await this.settleTrades(tx, market, order, sweep.trades as unknown as EngineTrade[], makerFeeRate, takerFeeRate);
      collected.push(...fills);
      remaining = remaining.sub(take);
      if (new Decimal(sweep.order.leaveQuantity.toString()).gt(0)) {
        try { book.cancel(sweepId); } catch { /* already fully matched */ }
      }
    }

    await this.updateOrderAfterMatch(tx, order.id, remaining, quantity);

    // Release reservation / close market order state if there's residual that
    // can't be filled against the current book.
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

  private async lockReservation(
    tx: Prisma.TransactionClient,
    userId: string,
    market: Prisma.MarketGetPayload<{}>,
    dto: CreateOrderDto,
    quantity: Decimal,
    limitPrice: Decimal | null,
  ) {
    if (dto.type === 'LIMIT') {
      const reserveBase = dto.side === 'ASK';
      const assetToLock = reserveBase ? market.baseAsset : market.quoteAsset;
      const reserveAmount = reserveBase ? quantity : limitPrice!.mul(quantity);
      const wallet = await tx.wallet.findUnique({
        where: { userId_asset: { userId, asset: assetToLock } },
      });
      if (!wallet) throw new BadRequestException(`no ${assetToLock} wallet`);
      if (new Decimal(wallet.balance.toString()).lt(reserveAmount)) {
        throw new BadRequestException('insufficient balance');
      }
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: { decrement: reserveAmount.toString() as unknown as Prisma.Decimal },
          locked: { increment: reserveAmount.toString() as unknown as Prisma.Decimal },
        },
      });
    } else if (dto.side === 'ASK') {
      const wallet = await tx.wallet.findUnique({
        where: { userId_asset: { userId, asset: market.baseAsset } },
      });
      if (!wallet) throw new BadRequestException(`no ${market.baseAsset} wallet`);
      if (new Decimal(wallet.balance.toString()).lt(quantity)) {
        throw new BadRequestException('insufficient base balance');
      }
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: { decrement: quantity.toString() as unknown as Prisma.Decimal },
          locked: { increment: quantity.toString() as unknown as Prisma.Decimal },
        },
      });
    }
    // MARKET BID: no upfront lock — deduct per fill.
  }

  async cancel(userId: string, orderId: bigint) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundException('order');
    if (order.status === 'FILLED' || order.status === 'CANCELLED') {
      throw new BadRequestException('order not active');
    }

    return this.matching.run(order.market, async () => {
      const market = await this.prisma.market.findUnique({ where: { symbol: order.market } });
      if (!market) throw new NotFoundException('market');
      const book = this.matching.getEngine(order.market);

      const updated = await this.prisma.$transaction(async (tx) => {
        try { book.cancel(Number(order.id)); } catch (err) {
          throw new BadRequestException((err as Error).message);
        }
        const leaveQty = new Decimal(order.leaveQty.toString());
        if (leaveQty.gt(0)) {
          if (order.side === 'BID' && order.price) {
            const releaseQuote = new Decimal(order.price.toString()).mul(leaveQty);
            await tx.wallet.update({
              where: { userId_asset: { userId, asset: market.quoteAsset } },
              data: {
                balance: { increment: releaseQuote.toString() as unknown as Prisma.Decimal },
                locked: { decrement: releaseQuote.toString() as unknown as Prisma.Decimal },
              },
            });
          } else if (order.side === 'ASK') {
            await tx.wallet.update({
              where: { userId_asset: { userId, asset: market.baseAsset } },
              data: {
                balance: { increment: leaveQty.toString() as unknown as Prisma.Decimal },
                locked: { decrement: leaveQty.toString() as unknown as Prisma.Decimal },
              },
            });
          }
        }
        return tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
      });

      await this.kafka.send<OrderEvent>(KAFKA_TOPICS.ORDERS, order.market, {
        v: 1,
        type: 'ORDER_CANCELLED',
        orderId: updated.id.toString(),
        userId: updated.userId,
        market: updated.market,
        side: updated.side,
        orderType: updated.type,
        price: updated.price?.toString() ?? null,
        quantity: updated.quantity.toString(),
        leaveQty: updated.leaveQty.toString(),
        filledQty: updated.filledQty.toString(),
        status: updated.status,
        ts: Date.now(),
      });
      await this.publishOrderbook(order.market);
      return this.presentOrder(updated);
    });
  }

  async listOpen(userId: string, market?: string) {
    const rows = await this.prisma.order.findMany({
      where: { userId, status: { in: ['OPEN', 'PARTIAL'] }, ...(market ? { market } : {}) },
      orderBy: { id: 'desc' },
    });
    return rows.map((o) => this.presentOrder(o));
  }

  async listHistory(userId: string, market?: string) {
    const rows = await this.prisma.order.findMany({
      where: { userId, ...(market ? { market } : {}) },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return rows.map((o) => this.presentOrder(o));
  }

  private validateTickStep(dto: CreateOrderDto, market: Prisma.MarketGetPayload<{}>) {
    const qty = new Decimal(dto.quantity);
    const step = new Decimal(market.stepSize.toString());
    if (!qty.mod(step).eq(0)) throw new BadRequestException('quantity violates stepSize');
    if (dto.type === 'LIMIT') {
      if (!dto.price) throw new BadRequestException('price required');
      const p = new Decimal(dto.price);
      const tick = new Decimal(market.tickSize.toString());
      if (!p.mod(tick).eq(0)) throw new BadRequestException('price violates tickSize');
      if (p.mul(qty).lt(market.minNotional.toString())) {
        throw new BadRequestException('below minNotional');
      }
    }
  }

  private async settleTrades(
    tx: Prisma.TransactionClient,
    market: Prisma.MarketGetPayload<{}>,
    takerOrder: Prisma.OrderGetPayload<{}>,
    trades: EngineTrade[],
    makerFeeRate: Decimal,
    takerFeeRate: Decimal,
  ) {
    const out: Prisma.TradeGetPayload<{}>[] = [];
    for (const t of trades) {
      const price = new Decimal(t.tradePrice.toString());
      const qty = new Decimal(t.tradeQuantity.toString());
      const makerOrderId = Number(t.makerOrderId);
      const maker = await tx.order.findUniqueOrThrow({ where: { id: BigInt(makerOrderId) } });
      const makerFee = qty.mul(makerFeeRate);
      const takerFee = qty.mul(takerFeeRate);
      const quoteAmt = price.mul(qty);

      const tradeRow = await tx.trade.create({
        data: {
          sequence: ++this.globalSeq,
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

  private async publishEvents(
    order: Prisma.OrderGetPayload<{}>,
    trades: Prisma.TradeGetPayload<{}>[],
    symbol: string,
  ) {
    await this.kafka.send<OrderEvent>(KAFKA_TOPICS.ORDERS, symbol, {
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
      const evt: TradeEvent = {
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
      await this.kafka.send<TradeEvent>(KAFKA_TOPICS.TRADES, symbol, evt);

      const userFilled: UserEvent = {
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
      await this.kafka.send<UserEvent>(KAFKA_TOPICS.USER_EVENTS, t.takerUserId, userFilled);
      await this.kafka.send<UserEvent>(KAFKA_TOPICS.USER_EVENTS, t.makerUserId, {
        ...userFilled,
        userId: t.makerUserId,
        payload: { ...userFilled.payload, orderId: t.makerOrderId.toString() },
      });
    }

    await this.publishOrderbook(symbol);
  }

  private async publishOrderbook(symbol: string) {
    const book = this.matching.getEngine(symbol);
    const ob = book.getOrderbook();
    const evt: OrderbookEvent = {
      v: 1,
      type: 'ORDERBOOK_SNAPSHOT',
      market: symbol,
      seq: Number(++this.globalSeq),
      asks: ob.asks.map((l) => ({ price: l.price, quantity: l.quantity })),
      bids: ob.bids.map((l) => ({ price: l.price, quantity: l.quantity })),
      ts: Date.now(),
    };
    await this.kafka.send<OrderbookEvent>(KAFKA_TOPICS.ORDERBOOK, symbol, evt);
  }

  private presentOrder(o: Prisma.OrderGetPayload<{}>) {
    return {
      id: o.id.toString(),
      market: o.market,
      side: o.side,
      type: o.type,
      price: o.price?.toString() ?? null,
      quantity: o.quantity.toString(),
      leaveQty: o.leaveQty.toString(),
      filledQty: o.filledQty.toString(),
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    };
  }
}
