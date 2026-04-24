import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { KafkaModule } from './kafka/kafka.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { WalletModule } from './wallet/wallet.module';
import { MarketModule } from './market/market.module';
import { OrderModule } from './order/order.module';
import { HealthModule } from './health/health.module';

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
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    PrismaModule,
    RedisModule,
    KafkaModule,
    AuthModule,
    UserModule,
    WalletModule,
    MarketModule,
    OrderModule,
    HealthModule,
  ],
})
export class AppModule {}
