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
import { MatchingModule } from './matching/matching.module';
import { MarketDataModule } from './market-data/market-data.module';
import { HealthModule } from './health/health.module';

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
    MatchingModule,
    OrderModule,
    MarketDataModule,
    HealthModule,
  ],
})
export class AppModule {}
