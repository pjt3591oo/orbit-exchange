import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import type Redis from 'ioredis';
import {
  CANDLE_INTERVAL_SECONDS,
  REDIS_KEYS,
  type CandleInterval,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';

type CandleRow = {
  market: string;
  interval: CandleInterval;
  openTime: number; // epoch millis, wire format
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

@Controller({ path: 'markets', version: '1' })
export class MarketController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  async list() {
    const markets = await this.prisma.market.findMany({ where: { enabled: true } });
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
    }));
  }

  /**
   * Orderbook snapshot. The matcher writes the latest book state to Redis
   * (`ob:snapshot:<symbol>`) on every match (throttled). API just reads.
   * Returns an empty book if the cache hasn't been populated yet (matcher
   * not running / new market with no activity).
   */
  @Get(':symbol/orderbook')
  async orderbook(@Param('symbol') symbol: string) {
    const cached = await this.redis.get(REDIS_KEYS.ORDERBOOK_SNAPSHOT(symbol));
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        /* fall through to empty book */
      }
    }
    return { symbol, asks: [], bids: [], ts: Date.now() };
  }

  @Get(':symbol/trades')
  async trades(@Param('symbol') symbol: string, @Query('limit') limit?: string) {
    const take = Math.min(Number(limit ?? 50), 200);
    const trades = await this.prisma.trade.findMany({
      where: { market: symbol },
      orderBy: { id: 'desc' },
      take,
    });
    return trades.map((t) => ({
      id: t.id.toString(),
      sequence: Number(t.sequence),
      market: t.market,
      price: t.price.toString(),
      quantity: t.quantity.toString(),
      takerSide: t.takerSide,
      ts: t.createdAt.getTime(),
    }));
  }

  /**
   * Candles endpoint.
   *
   * We only persist M1 bars; higher intervals are aggregated on-the-fly
   * from M1 rows. This keeps write amplification low and lets us add
   * new timeframes without a backfill, at the cost of a bounded in-memory
   * group-by on read.
   */
  @Get(':symbol/candles')
  async candles(
    @Param('symbol') symbol: string,
    @Query('interval') intervalRaw = 'M1',
    @Query('limit') limit = '500',
  ): Promise<CandleRow[]> {
    const interval = intervalRaw as CandleInterval;
    const intervalSec = CANDLE_INTERVAL_SECONDS[interval];
    if (!intervalSec) throw new BadRequestException(`unknown interval ${intervalRaw}`);

    const take = Math.min(Number(limit), 1000);

    if (interval === 'M1') {
      const rows = await this.prisma.candle.findMany({
        where: { market: symbol, interval: 'M1' },
        orderBy: { openTime: 'desc' },
        take,
      });
      return rows.reverse().map((c) => this.present(c));
    }

    // Aggregate: pull M1 rows covering `take` buckets, bucketed server-side
    // via floor(openTime / intervalSec). We fetch slightly extra so the
    // newest partial bucket doesn't get dropped at the edge.
    const lookbackMs = take * intervalSec * 1000;
    const since = new Date(Date.now() - lookbackMs);
    const m1 = await this.prisma.candle.findMany({
      where: { market: symbol, interval: 'M1', openTime: { gte: since } },
      orderBy: { openTime: 'asc' },
    });

    const buckets = new Map<number, CandleRow>();
    for (const c of m1) {
      const bucketSec =
        Math.floor(c.openTime.getTime() / 1000 / intervalSec) * intervalSec;
      const existing = buckets.get(bucketSec);
      if (!existing) {
        buckets.set(bucketSec, {
          market: symbol,
          interval,
          openTime: bucketSec * 1000,
          open: c.open.toString(),
          high: c.high.toString(),
          low: c.low.toString(),
          close: c.close.toString(),
          volume: c.volume.toString(),
        });
      } else {
        existing.high = Decimal.max(existing.high, c.high.toString()).toString();
        existing.low = Decimal.min(existing.low, c.low.toString()).toString();
        existing.close = c.close.toString();
        existing.volume = new Decimal(existing.volume).add(c.volume.toString()).toString();
      }
    }

    const sorted = [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
    return sorted.slice(-take);
  }

  private present(c: {
    market: string;
    interval: string;
    openTime: Date;
    open: { toString(): string };
    high: { toString(): string };
    low: { toString(): string };
    close: { toString(): string };
    volume: { toString(): string };
  }): CandleRow {
    return {
      market: c.market,
      interval: c.interval as CandleInterval,
      openTime: c.openTime.getTime(),
      open: c.open.toString(),
      high: c.high.toString(),
      low: c.low.toString(),
      close: c.close.toString(),
      volume: c.volume.toString(),
    };
  }
}
