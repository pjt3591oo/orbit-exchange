import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * The realtime service needs two Redis clients:
 *  - REDIS_SUB: for `psubscribe('md:*')`. Once a connection is in subscribe
 *    mode, no other commands can be issued on it (ioredis enforces this).
 *  - REDIS_CLIENT: for plain GET on the orderbook snapshot cache, which
 *    fires on each new client subscription.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const REDIS_SUB = Symbol('REDIS_SUB');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    },
    {
      provide: REDIS_SUB,
      useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    },
  ],
  exports: [REDIS_CLIENT, REDIS_SUB],
})
export class RedisModule {}
