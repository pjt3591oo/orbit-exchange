import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { pinoOtelMixin, pinoTransport } from '@orbit/observability';
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
        mixin: pinoOtelMixin,
        transport: pinoTransport('orbit-realtime'),
        // Same minimal serializer / probe-skip / level-by-status policy as
        // apps/api — see app.module there for rationale.
        serializers: {
          req: (req: { id?: unknown; method: string; url: string }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
        autoLogging: {
          ignore: (req: { url?: string }) => {
            const url = req.url ?? '';
            return (
              url.startsWith('/health') ||
              url.startsWith('/ready') ||
              url.startsWith('/metrics') ||
              // Socket.IO upgrade handshake noise — the actual WS frames
              // don't go through pino-http anyway, but the polling
              // fallback hits /socket.io/?EIO=4&transport=polling once
              // every few seconds per client.
              url.startsWith('/socket.io')
            );
          },
        },
        customLogLevel: (
          _req: unknown,
          res: { statusCode: number },
          err: unknown,
        ) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
      },
    }),
    RedisModule,
    MarketDataModule,
    HealthModule,
  ],
})
export class AppModule {}
