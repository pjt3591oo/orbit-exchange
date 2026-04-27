import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard() {
    const since24h = new Date(Date.now() - 24 * 3600_000);

    const [userCount, marketCount, enabledMarketCount, openOrderCount, recentTrades] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.market.count(),
        this.prisma.market.count({ where: { enabled: true } }),
        this.prisma.order.count({ where: { status: { in: ['OPEN', 'PARTIAL'] } } }),
        this.prisma.trade.findMany({
          where: { createdAt: { gte: since24h } },
          select: { market: true, price: true, quantity: true },
          take: 10_000, // bound the scan
        }),
      ]);

    // Sum 24h notional grouped by market — convert non-KRW markets to KRW via
    // the latest mid price of that market's quote pair (if available). MVP:
    // only sum notional for KRW-quoted markets; leave others as-is.
    let krwVolume = new Decimal(0);
    for (const t of recentTrades) {
      if (t.market.endsWith('-KRW')) {
        krwVolume = krwVolume.plus(new Decimal(t.price.toString()).mul(t.quantity.toString()));
      }
    }

    return {
      userCount,
      marketCount,
      enabledMarketCount,
      openOrderCount,
      trades24h: recentTrades.length,
      volume24hKrw: krwVolume.toFixed(0),
    };
  }
}
