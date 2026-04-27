import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Orderbook, TRADE_SIDE } from 'orderbook-match-engine';
import PQueue from 'p-queue';
import { metrics } from '@orbit/observability';
import { PrismaService } from '../prisma/prisma.service';

const M = metrics.Metrics;

type MarketSymbol = string;

/**
 * Owns the in-memory Orderbook for every enabled market and serializes
 * writes through a per-market p-queue (concurrency=1). On boot, replays all
 * OPEN/PARTIAL limit orders from DB so the in-memory book matches the
 * persisted truth.
 *
 * This service is the single owner of the orderbook in the matcher process —
 * neither API nor realtime ever instantiate it.
 */
@Injectable()
export class MatchingEngineService implements OnModuleInit {
  private readonly log = new Logger(MatchingEngineService.name);
  private readonly books = new Map<MarketSymbol, Orderbook>();
  private readonly queues = new Map<MarketSymbol, PQueue>();
  /**
   * ADR-0001 §D2 — readiness flag.
   *
   * Flipped to true only after `replayOpenOrders()` has rebuilt every
   * in-memory book from DB. The Kafka consumer waits on this before
   * subscribing (see CommandConsumerService.onModuleInit), and the
   * `/ready` HTTP probe gates load-balancer traffic on it.
   *
   * Read order matters: NestJS's `OnModuleInit` runs all modules in
   * dependency order, so MatchingEngineService.onModuleInit completes
   * before CommandConsumerService.onModuleInit starts. The flag makes
   * that ordering an *explicit invariant* rather than something that
   * silently breaks if the lifecycle changes.
   */
  private _ready = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const markets = await this.prisma.market.findMany({ where: { enabled: true } });
    for (const m of markets) this.ensureBook(m.symbol);
    await this.replayOpenOrders();
    this._ready = true;
    this.log.log(`matching engines ready: ${[...this.books.keys()].join(', ')}`);
  }

  /** True once boot-time replay has finished. See class doc on `_ready`. */
  isReady(): boolean {
    return this._ready;
  }

  getEngine(symbol: string): Orderbook {
    return this.ensureBook(symbol);
  }

  /** All symbols this matcher owns an in-memory book for. */
  getAllSymbols(): string[] {
    return [...this.books.keys()];
  }

  /** Serialize a task against this market's write lane. */
  async run<T>(symbol: string, task: () => Promise<T>): Promise<T> {
    const q = this.getQueue(symbol);
    M.matcherQueueDepth.set({ symbol }, q.size + q.pending);
    try {
      const result = await q.add(task);
      return result as T;
    } finally {
      M.matcherQueueDepth.set({ symbol }, q.size + q.pending);
    }
  }

  sideToEngine(side: 'BID' | 'ASK'): TRADE_SIDE {
    return side === 'BID' ? TRADE_SIDE.BID : TRADE_SIDE.ASK;
  }

  private getQueue(symbol: string): PQueue {
    let q = this.queues.get(symbol);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.queues.set(symbol, q);
    }
    return q;
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
