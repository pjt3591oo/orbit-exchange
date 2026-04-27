import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminTradesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(opts: {
    market?: string;
    userId?: string;
    since?: string;
    until?: string;
    take?: number;
    cursor?: string;
  }) {
    const where: Prisma.TradeWhereInput = {};
    if (opts.market) where.market = opts.market;
    if (opts.userId) where.OR = [{ makerUserId: opts.userId }, { takerUserId: opts.userId }];
    if (opts.since || opts.until) {
      where.createdAt = {
        ...(opts.since && { gte: new Date(opts.since) }),
        ...(opts.until && { lte: new Date(opts.until) }),
      };
    }
    const take = Math.min(opts.take ?? 50, 200);
    const rows = await this.prisma.trade.findMany({
      where,
      orderBy: { id: 'desc' },
      take: take + 1,
      ...(opts.cursor && { cursor: { id: BigInt(opts.cursor) }, skip: 1 }),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items: items.map((t) => ({
        id: t.id.toString(),
        market: t.market,
        price: t.price.toString(),
        quantity: t.quantity.toString(),
        makerOrderId: t.makerOrderId.toString(),
        takerOrderId: t.takerOrderId.toString(),
        makerUserId: t.makerUserId,
        takerUserId: t.takerUserId,
        makerSide: t.makerSide,
        takerSide: t.takerSide,
        makerFee: t.makerFee.toString(),
        takerFee: t.takerFee.toString(),
        createdAt: t.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? items[items.length - 1].id.toString() : null,
    };
  }
}
