import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_KEYS } from '@orbit/shared';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Reads the latest orderbook snapshot for a symbol from the Redis cache the
 * matcher writes into. Returns `null` if the cache is empty (matcher not
 * running yet, or new market with no activity). The gateway falls back to
 * an empty book in that case so the client UI doesn't hang.
 */
@Injectable()
export class SnapshotCacheService {
  private readonly log = new Logger(SnapshotCacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async getOrderbook(symbol: string): Promise<unknown | null> {
    try {
      const cached = await this.redis.get(REDIS_KEYS.ORDERBOOK_SNAPSHOT(symbol));
      if (!cached) return null;
      return JSON.parse(cached);
    } catch (err) {
      this.log.warn(`snapshot read failed ${symbol}: ${(err as Error).message}`);
      return null;
    }
  }
}
