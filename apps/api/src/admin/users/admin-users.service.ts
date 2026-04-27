import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List users with optional fuzzy email/id filter.
   * Capped at 100 rows; supports cursor pagination (cursor = last id).
   */
  async list(opts: { q?: string; take?: number; cursor?: string }) {
    const where: Prisma.UserWhereInput = opts.q
      ? {
          OR: [
            { email: { contains: opts.q, mode: 'insensitive' } },
            { id: { contains: opts.q } },
          ],
        }
      : {};
    const take = Math.min(opts.take ?? 50, 100);
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(opts.cursor && { cursor: { id: opts.cursor }, skip: 1 }),
      select: {
        id: true,
        email: true,
        frozen: true,
        createdAt: true,
        _count: { select: { orders: true, wallets: true } },
      },
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items: items.map((u) => ({
        id: u.id,
        email: u.email,
        frozen: u.frozen,
        createdAt: u.createdAt.toISOString(),
        orderCount: u._count.orders,
        walletCount: u._count.wallets,
      })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  /**
   * User detail — basic fields + all wallets + recent 20 orders + recent 20 trades.
   * Heavier than list(); use only on the detail page.
   */
  async detail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        wallets: {
          orderBy: { asset: 'asc' },
        },
        orders: {
          orderBy: { id: 'desc' },
          take: 20,
        },
      },
    });
    if (!user) throw new NotFoundException('user not found');

    const trades = await this.prisma.trade.findMany({
      where: { OR: [{ makerUserId: id }, { takerUserId: id }] },
      orderBy: { id: 'desc' },
      take: 20,
    });

    return {
      id: user.id,
      email: user.email,
      frozen: user.frozen,
      createdAt: user.createdAt.toISOString(),
      wallets: user.wallets.map((w) => ({
        asset: w.asset,
        balance: w.balance.toString(),
        locked: w.locked.toString(),
      })),
      orders: user.orders.map((o) => ({
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
      })),
      trades: trades.map((t) => ({
        id: t.id.toString(),
        market: t.market,
        price: t.price.toString(),
        quantity: t.quantity.toString(),
        side: t.makerUserId === id ? t.makerSide : t.takerSide,
        role: t.makerUserId === id ? 'maker' : 'taker',
        fee: (t.makerUserId === id ? t.makerFee : t.takerFee).toString(),
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }

  async setFrozen(id: string, frozen: boolean) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new NotFoundException('user not found');
    const updated = await this.prisma.user.update({
      where: { id },
      data: { frozen },
      select: { id: true, email: true, frozen: true },
    });
    return updated;
  }
}
