import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { RedisModule } from './redis/redis.module';
import { MarketDataModule } from './market-data/market-data.module';
import { HealthModule } from './health/health.module';

/**
 * apps/realtime is WebSocket-only after the matcher/api split. It owns the
 * Socket.IO gateway, subscribes to Redis pub/sub channels populated by
 * workers/market-data-fanout, and serves orderbook snapshots from the
 * Redis cache the matcher writes.
 *
 * No DB, no Kafka producer, no matching engine — keeps this pod lightweight
 * and trivially horizontally scalable.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    RedisModule,
    MarketDataModule,
    HealthModule,
  ],
})
export class AppModule {}
