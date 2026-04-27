import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type Redis from 'ioredis';
import { Prisma } from '@prisma/client';
import { REDIS_KEYS } from '@orbit/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';

export interface MarketUpdateInput {
  enabled?: boolean;
  tickSize?: string;
  stepSize?: string;
  minNotional?: string;
  takerFeeBp?: number;
  makerFeeBp?: number;
}

@Injectable()
export class AdminMarketsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async list() {
    const [markets, openCounts, trade24h] = await Promise.all([
      this.prisma.market.findMany({ orderBy: { symbol: 'asc' } }),
      this.prisma.order.groupBy({
        by: ['market'],
        where: { status: { in: ['OPEN', 'PARTIAL'] } },
        _count: { _all: true },
      }),
      this.prisma.trade.groupBy({
        by: ['market'],
        where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        _count: { _all: true },
      }),
    ]);
    const openMap = new Map(openCounts.map((r) => [r.market, r._count._all]));
    const tradeMap = new Map(trade24h.map((r) => [r.market, r._count._all]));
    return markets.map((m) => ({
      symbol: m.symbol,
      baseAsset: m.baseAsset,
      quoteAsset: m.quoteAsset,
      tickSize: m.tickSize.toString(),
      stepSize: m.stepSize.toString(),
      minNotional: m.minNotional.toString(),
      takerFeeBp: m.takerFeeBp,
      makerFeeBp: m.makerFeeBp,
      enabled: m.enabled,
      openOrderCount: openMap.get(m.symbol) ?? 0,
      trades24h: tradeMap.get(m.symbol) ?? 0,
    }));
  }

  async detail(symbol: string) {
    const market = await this.prisma.market.findUnique({ where: { symbol } });
    if (!market) throw new NotFoundException('market not found');

    const cached = await this.redis.get(REDIS_KEYS.ORDERBOOK_SNAPSHOT(symbol));
    let snapshot: unknown = null;
    if (cached) {
      try { snapshot = JSON.parse(cached); } catch { /* ignore */ }
    }

    return {
      symbol: market.symbol,
      baseAsset: market.baseAsset,
      quoteAsset: market.quoteAsset,
      tickSize: market.tickSize.toString(),
      stepSize: market.stepSize.toString(),
      minNotional: market.minNotional.toString(),
      takerFeeBp: market.takerFeeBp,
      makerFeeBp: market.makerFeeBp,
      enabled: market.enabled,
      orderbook: snapshot,
    };
  }

  async update(symbol: string, input: MarketUpdateInput) {
    const before = await this.prisma.market.findUnique({ where: { symbol } });
    if (!before) throw new NotFoundException('market not found');

    const data: Prisma.MarketUpdateInput = {};
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.tickSize !== undefined)
      data.tickSize = new Prisma.Decimal(input.tickSize);
    if (input.stepSize !== undefined)
      data.stepSize = new Prisma.Decimal(input.stepSize);
    if (input.minNotional !== undefined)
      data.minNotional = new Prisma.Decimal(input.minNotional);
    if (input.takerFeeBp !== undefined) data.takerFeeBp = input.takerFeeBp;
    if (input.makerFeeBp !== undefined) data.makerFeeBp = input.makerFeeBp;

    const after = await this.prisma.market.update({ where: { symbol }, data });
    return {
      before: this.present(before),
      after: this.present(after),
    };
  }

  private present(m: {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    tickSize: { toString(): string };
    stepSize: { toString(): string };
    minNotional: { toString(): string };
    takerFeeBp: number;
    makerFeeBp: number;
    enabled: boolean;
  }) {
    return {
      symbol: m.symbol,
      baseAsset: m.baseAsset,
      quoteAsset: m.quoteAsset,
      tickSize: m.tickSize.toString(),
      stepSize: m.stepSize.toString(),
      minNotional: m.minNotional.toString(),
      takerFeeBp: m.takerFeeBp,
      makerFeeBp: m.makerFeeBp,
      enabled: m.enabled,
    };
  }
}
