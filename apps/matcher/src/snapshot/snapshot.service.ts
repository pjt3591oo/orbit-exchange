import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  ORDERBOOK_SNAPSHOT_TTL_SEC,
  REDIS_KEYS,
} from '@orbit/shared';
import { MatchingEngineService } from '../matching/matching-engine.service';
import { REDIS_CLIENT } from '../redis/redis.module';

const THROTTLE_MS = 100;

/**
 * Writes the latest orderbook snapshot for a market to Redis SET (not pub/sub)
 * so that NEW WS subscribers in the realtime service can fetch the current
 * book state immediately on connect — pub/sub is fire-and-forget so it can't
 * help late joiners.
 *
 * Throttled per-symbol to ~10 writes/sec to keep Redis lean. Live updates
 * still flow via Kafka → fanout → Redis pub/sub at full rate.
 */
@Injectable()
export class SnapshotService implements OnModuleInit {
  private readonly log = new Logger(SnapshotService.name);
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly lastWrite = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly matching: MatchingEngineService,
  ) {}

  /**
   * After replay, push a snapshot for every market we own. Without this, a
   * freshly booted matcher leaves Redis empty until the first new event,
   * which means every WS subscriber that connects in the meantime gets a
   * blank book. Nest guarantees this runs after MatchingEngineService's own
   * onModuleInit (we depend on it via DI), so the books are populated.
   */
  async onModuleInit() {
    const symbols = this.matching.getAllSymbols();
    await Promise.all(symbols.map((s) => this.write(s)));
    if (symbols.length) {
      this.log.log(`bootstrapped snapshots for ${symbols.length} market(s)`);
    }
  }

  /** Schedule a snapshot write. Coalesces bursts into one write per ~100ms. */
  schedule(symbol: string) {
    const now = Date.now();
    const last = this.lastWrite.get(symbol) ?? 0;
    const elapsed = now - last;

    if (elapsed >= THROTTLE_MS) {
      // Cool — write immediately.
      void this.write(symbol);
      return;
    }

    if (this.pending.has(symbol)) return; // already queued

    const delay = THROTTLE_MS - elapsed;
    const timer = setTimeout(() => {
      this.pending.delete(symbol);
      void this.write(symbol);
    }, delay);
    this.pending.set(symbol, timer);
  }

  private async write(symbol: string) {
    try {
      const book = this.matching.getEngine(symbol);
      const ob = book.getOrderbook();
      const payload = JSON.stringify({
        symbol,
        asks: ob.asks.map((l) => ({ price: l.price, quantity: l.quantity })),
        bids: ob.bids.map((l) => ({ price: l.price, quantity: l.quantity })),
        ts: Date.now(),
      });
      await this.redis.set(
        REDIS_KEYS.ORDERBOOK_SNAPSHOT(symbol),
        payload,
        'EX',
        ORDERBOOK_SNAPSHOT_TTL_SEC,
      );
      this.lastWrite.set(symbol, Date.now());
    } catch (err) {
      this.log.warn(`snapshot write failed ${symbol}: ${(err as Error).message}`);
    }
  }
}
