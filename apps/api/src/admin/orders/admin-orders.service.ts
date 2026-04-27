import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type OrderStatus } from '@prisma/client';
import {
  KAFKA_TOPICS,
  type OrderCancelCommand,
} from '@orbit/shared';
import { metrics } from '@orbit/observability';
import { PrismaService } from '../../prisma/prisma.service';
import { KafkaProducerService } from '../../kafka/kafka-producer.service';

const M = metrics.Metrics;

@Injectable()
export class AdminOrdersService {
  private readonly log = new Logger(AdminOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(opts: {
    userId?: string;
    market?: string;
    status?: string;
    since?: string;
    until?: string;
    take?: number;
    cursor?: string;
  }) {
    const where: Prisma.OrderWhereInput = {};
    if (opts.userId) where.userId = opts.userId;
    if (opts.market) where.market = opts.market;
    if (opts.status) {
      const statuses = opts.status
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean) as OrderStatus[];
      if (statuses.length) where.status = { in: statuses };
    }
    if (opts.since || opts.until) {
      where.createdAt = {
        ...(opts.since && { gte: new Date(opts.since) }),
        ...(opts.until && { lte: new Date(opts.until) }),
      };
    }
    const take = Math.min(opts.take ?? 50, 200);
    const rows = await this.prisma.order.findMany({
      where,
      orderBy: { id: 'desc' },
      take: take + 1,
      ...(opts.cursor && { cursor: { id: BigInt(opts.cursor) }, skip: 1 }),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items: items.map((o) => this.present(o)),
      nextCursor: hasMore ? items[items.length - 1].id.toString() : null,
    };
  }

  async detail(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(orderId) },
    });
    if (!order) throw new NotFoundException('order not found');
    return this.present(order);
  }

  /**
   * Force-cancel publishes the same Kafka command the user-side cancel does.
   * Matcher's idempotency means it's safe to publish even if the order is
   * already inactive (it just no-ops). We refuse here only as UX courtesy.
   */
  async forceCancel(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(orderId) },
    });
    if (!order) throw new NotFoundException('order not found');
    if (order.status === 'FILLED' || order.status === 'CANCELLED') {
      throw new BadRequestException(`order is already ${order.status}`);
    }

    const cmd: OrderCancelCommand = {
      v: 1,
      type: 'CANCEL',
      orderId: order.id.toString(),
      userId: order.userId,
      symbol: order.market,
      ts: Date.now(),
    };

    try {
      await this.kafka.send<OrderCancelCommand>(
        KAFKA_TOPICS.ORDER_COMMANDS,
        order.market,
        cmd,
      );
      M.ordersCancelled.inc({ market: order.market, origin: 'admin' });
    } catch (err) {
      this.log.error(`force-cancel publish failed: ${(err as Error).message}`);
      throw err;
    }

    return {
      orderId: order.id.toString(),
      status: order.status,
      cancelRequestedAt: new Date().toISOString(),
      note: 'CANCEL command published; matcher will transition status asynchronously',
    };
  }

  private present(o: {
    id: bigint;
    userId: string;
    market: string;
    side: string;
    type: string;
    price: { toString(): string } | null;
    quantity: { toString(): string };
    leaveQty: { toString(): string };
    filledQty: { toString(): string };
    status: string;
    createdAt: Date;
  }) {
    return {
      id: o.id.toString(),
      userId: o.userId,
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
