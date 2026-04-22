import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Orderbook, TRADE_SIDE } from 'orderbook-match-engine';
import PQueue from 'p-queue';
import { PrismaService } from '../prisma/prisma.service';

type MarketSymbol = string;

/**
 * Owns one matching engine instance per market and serializes writes
 * through a per-market p-queue so engine state and DB state stay aligned.
 *
 * We use `Orderbook` directly (not `Engine`) because we persist inside the
 * caller's `prisma.$transaction`; going through `Engine` hooks would require
 * async propagation across the tx boundary.
 */
@Injectable()
export class MatchingEngineService implements OnModuleInit {
  private readonly log = new Logger(MatchingEngineService.name);
  private books = new Map<MarketSymbol, Orderbook>();
  private queues = new Map<MarketSymbol, PQueue>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const markets = await this.prisma.market.findMany({ where: { enabled: true } });
    for (const m of markets) this.ensureBook(m.symbol);

    await this.replayOpenOrders();
    this.log.log(`matching engines ready: ${[...this.books.keys()].join(', ')}`);
  }

  getEngine(symbol: string): Orderbook {
    return this.ensureBook(symbol);
  }

  getQueue(symbol: string): PQueue {
    let q = this.queues.get(symbol);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.queues.set(symbol, q);
    }
    return q;
  }

  /** Serialize a task against this market's write lane. */
  async run<T>(symbol: string, task: () => Promise<T>): Promise<T> {
    const result = await this.getQueue(symbol).add(task);
    return result as T;
  }

  sideToEngine(side: 'BID' | 'ASK'): TRADE_SIDE {
    return side === 'BID' ? TRADE_SIDE.BID : TRADE_SIDE.ASK;
  }

  private ensureBook(symbol: string): Orderbook {
    let b = this.books.get(symbol);
    if (!b) {
      b = new Orderbook({ limit: 15 });
      this.books.set(symbol, b);
    }
    return b;
  }

  private async replayOpenOrders() {
    const open = await this.prisma.order.findMany({
      where: { status: { in: ['OPEN', 'PARTIAL'] }, type: 'LIMIT' },
      orderBy: { id: 'asc' },
    });
    for (const o of open) {
      if (!o.price) continue;
      const side = this.sideToEngine(o.side);
      const book = this.ensureBook(o.market);
      try {
        book.add(Number(o.id), side, o.price.toString(), o.leaveQty.toString());
      } catch (err) {
        this.log.warn(`replay skip order=${o.id}: ${(err as Error).message}`);
      }
    }
    if (open.length) this.log.log(`replayed ${open.length} open orders`);
  }
}
