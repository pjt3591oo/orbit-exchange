import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { pinoOtelMixin, pinoTransport } from '@orbit/observability';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { KafkaModule } from './kafka/kafka.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { WalletModule } from './wallet/wallet.module';
import { MarketModule } from './market/market.module';
import { OrderModule } from './order/order.module';
import { HealthModule } from './health/health.module';
import { AdminModule } from './admin/admin.module';
import { IdempotencyModule } from './idempotency/idempotency.module';

/**
 * apps/api is HTTP-only after the matcher/realtime split:
 *   - controllers (auth, user, wallet, market, order) handle REST
 *   - OrderModule publishes commands to Kafka (orbit.order-commands.v1)
 *   - WS gateway lives in apps/realtime
 *   - matching engine lives in apps/matcher
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        // Inject trace_id / span_id from active OTel context into every log
        // line — Loki's derived field then renders a "View trace" link.
        mixin: pinoOtelMixin,
        transport: pinoTransport('orbit-api'),
        // Default pino-http serializers dump ALL request and response
        // headers per line — a single GET produces ~600 chars (CSP,
        // sec-fetch-*, accept-language, helmet headers …). Replace with a
        // minimum that's actually useful when grep'ing dev logs. Header-
        // level inspection still possible via Tempo span attributes.
        serializers: {
          req: (req: { id?: unknown; method: string; url: string }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
        // Probe endpoints get hit every ~5–15s by Prometheus / k8s. Their
        // access logs are pure noise.
        autoLogging: {
          ignore: (req: { url?: string }) => {
            const url = req.url ?? '';
            return (
              url.startsWith('/health') ||
              url.startsWith('/ready') ||
              url.startsWith('/metrics')
            );
          },
        },
        // 5xx → error, 4xx → warn, everything else → info. Lets `LOG_LEVEL=warn`
        // in production silently drop the happy-path access spam while still
        // surfacing real problems.
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
    PrismaModule,
    RedisModule,
    KafkaModule,
    IdempotencyModule,
    AuthModule,
    UserModule,
    WalletModule,
    MarketModule,
    OrderModule,
    HealthModule,
    AdminModule,
  ],
})
export class AppModule {}
