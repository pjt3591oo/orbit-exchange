import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxPublisherService } from '../kafka/outbox-publisher.service';
import {
  KAFKA_TOPICS,
  type OrderCancelCommand,
  type OrderSubmitCommand,
} from '@orbit/shared';
import { metrics } from '@orbit/observability';
import type { CreateOrderDto } from './dto';

const M = metrics.Metrics;

/**
 * HTTP-side order service. After the matcher was extracted, this service is
 * intentionally thin:
 *
 *   submit():
 *     1. validate market / tick / step / notional / quantity / price
 *     2. lock the user's reserved balance (LIMIT) in a single $transaction
 *        and INSERT the Order row with status=OPEN, leaveQty=quantity
 *     3. publish a SUBMIT command to Kafka (orbit.order-commands.v1) keyed
 *        by symbol — the matcher consumes that topic and runs the actual
 *        match in-memory, then settles trades + balances in its own
 *        $transaction
 *     4. return the order to the caller (status: OPEN; subsequent fills
 *        flow back to the user via the WS push pipeline)
 *
 *   cancel():
 *     1. verify order ownership / cancellable status (read-only)
 *     2. publish a CANCEL command — the matcher removes from book, refunds
 *        the locked balance, and updates the Order row
 *     3. return the current order state (status flips to CANCELLED via WS
 *        once the matcher processes the command)
 *
 * MARKET orders: API still inserts the order but performs no upfront lock
 * for MARKET BIDs (the matcher deducts per fill). MARKET ASKs lock the base
 * asset upfront, same as before. The matcher handles the per-level sweep.
 */
@Injectable()
export class OrderService {
  private readonly log = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxPublisherService,
  ) {}

  async submit(userId: string, dto: CreateOrderDto) {
    const t0 = Date.now();
    const labels = { market: dto.market, side: dto.side, type: dto.type };
    try {
      const result = await this._submitInner(userId, dto);
      M.ordersSubmitted.inc({ ...labels, result: 'ok' });
      return result;
    } catch (err) {
      // 4xx (BadRequest / NotFound / Forbidden) vs 5xx (anything else)
      const code = (err as { status?: number }).status ?? 500;
      M.ordersSubmitted.inc({ ...labels, result: code >= 500 ? '5xx' : '4xx' });
      if (err instanceof ForbiddenException && err.message.includes('frozen')) {
        M.frozenBlocks.inc();
      }
      throw err;
    } finally {
      M.orderSubmitDuration.observe({ market: dto.market }, Date.now() - t0);
    }
  }

  private async _submitInner(userId: string, dto: CreateOrderDto) {
    // Block submissions from frozen users (set by an admin via WALLET_ADJUST).
    // We only check status here, not balance — that comes in lockReservation.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { frozen: true },
    });
    if (!user) throw new NotFoundException('user not found');
    if (user.frozen) throw new ForbiddenException('account is frozen — contact support');

    const market = await this.prisma.market.findUnique({ where: { symbol: dto.market } });
    if (!market || !market.enabled) throw new NotFoundException('market not found');
    this.validateTickStep(dto, market);

    const quantity = new Decimal(dto.quantity);
    if (quantity.lte(0)) throw new BadRequestException('quantity must be > 0');

    const limitPrice = dto.type === 'LIMIT' ? new Decimal(dto.price!) : null;
    if (dto.type === 'LIMIT' && (!limitPrice || limitPrice.lte(0))) {
      throw new BadRequestException('price required for LIMIT');
    }

    // Mint the commandId up-front so it's persisted on the Order row AND
    // shipped via the SUBMIT command. Matcher uses it to dedupe duplicate
    // delivery (ADR-0003 §D3) and as the prefix of every Trade.matchId.
    const commandId = randomUUID();

    const order = await this.prisma.$transaction(
      async (tx) => {
        await this.lockReservation(tx, userId, market, dto, quantity, limitPrice);
        const created = await tx.order.create({
          data: {
            userId,
            market: dto.market,
            side: dto.side,
            type: dto.type,
            price: limitPrice ? new Prisma.Decimal(limitPrice.toString()) : null,
            quantity: new Prisma.Decimal(quantity.toString()),
            leaveQty: new Prisma.Decimal(quantity.toString()),
            commandId,
          },
        });

        // Outbox row in the SAME transaction — atomic with the Order INSERT.
        // The outbox-relay worker picks it up and publishes to Kafka. If the
        // process crashes between commit and publish, the row is still in
        // the table and the relay catches up on next tick (ADR-0002).
        const cmd: OrderSubmitCommand = {
          v: 1,
          type: 'SUBMIT',
          commandId,
          orderId: created.id.toString(),
          userId,
          symbol: dto.market,
          side: dto.side,
          ordType: dto.type,
          price: limitPrice?.toString() ?? null,
          quantity: quantity.toString(),
          ts: Date.now(),
        };
        await this.outbox.publish(tx, {
          topic: KAFKA_TOPICS.ORDER_COMMANDS,
          key: dto.market,
          payload: cmd,
        });

        return created;
      },
      { isolationLevel: 'ReadCommitted', timeout: 10_000 },
    );

    return this.presentOrder(order);
  }

  async cancel(userId: string, orderId: bigint) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundException('order');
    if (order.status === 'FILLED' || order.status === 'CANCELLED') {
      throw new BadRequestException('order not active');
    }

    // CANCEL uses outbox too — same dual-write reasoning as SUBMIT. We don't
    // need a new transaction since we're not mutating any other row, but a
    // tiny `$transaction` keeps the publish path uniform.
    const commandId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const cmd: OrderCancelCommand = {
        v: 1,
        type: 'CANCEL',
        commandId,
        orderId: order.id.toString(),
        userId,
        symbol: order.market,
        ts: Date.now(),
      };
      await this.outbox.publish(tx, {
        topic: KAFKA_TOPICS.ORDER_COMMANDS,
        key: order.market,
        payload: cmd,
      });
    });

    M.ordersCancelled.inc({ market: order.market, origin: 'user' });

    // Return the current row — the WS feed will surface the CANCELLED state
    // once the matcher applies the command.
    return this.presentOrder(order);
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

  /* ───────────────── internals ───────────────── */

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
    // MARKET BID: no upfront lock — matcher deducts per fill.
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
