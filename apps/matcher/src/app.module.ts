import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { pinoOtelMixin, pinoTransport } from '@orbit/observability';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { KafkaModule } from './kafka/kafka.module';
import { MatchingModule } from './matching/matching.module';
import { SettlerModule } from './settler/settler.module';
import { SnapshotModule } from './snapshot/snapshot.module';
import { ConsumerModule } from './consumer/consumer.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        mixin: pinoOtelMixin,
        transport: pinoTransport('orbit-matcher'),
      },
    }),
    PrismaModule,
    RedisModule,
    KafkaModule,
    MatchingModule,
    SettlerModule,
    SnapshotModule,
    ConsumerModule,
  ],
})
export class AppModule {}
