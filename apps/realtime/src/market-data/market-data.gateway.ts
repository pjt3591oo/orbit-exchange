import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type Redis from 'ioredis';
import { REDIS_SUB } from '../redis/redis.module';
import { SnapshotCacheService } from './snapshot-cache.service';

/**
 * Socket.IO gateway for market-data push.
 *
 * Upstream pipeline:
 *   matcher → Kafka (trades, orderbook, etc.)
 *           → workers/market-data-fanout (Kafka consumer)
 *           → Redis pub/sub (`md:<symbol>:<kind>`)
 *           → realtime pods psubscribe → emit to room
 *
 * The realtime service is intentionally stateless and matcher-agnostic —
 * scaling it horizontally just adds more pods on the same Redis fanout.
 *
 * For new subscribers, we read the most recent orderbook snapshot from
 * Redis SET (`ob:snapshot:<symbol>`) which the matcher refreshes on every
 * match. Pub/sub alone can't help late joiners since it's fire-and-forget.
 */
@WebSocketGateway({
  cors: { origin: process.env.API_CORS_ORIGIN?.split(',') ?? true, credentials: true },
  namespace: '/market',
})
export class MarketDataGateway
  implements OnModuleInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly log = new Logger(MarketDataGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    @Inject(REDIS_SUB) private readonly sub: Redis,
    private readonly snapshotCache: SnapshotCacheService,
  ) {}

  onModuleInit() {
    this.sub.psubscribe('md:*');
    this.sub.on('pmessage', (_pattern, channel, message) => {
      const room = channel; // e.g. "md:BTC-KRW:trade"
      try {
        const payload = JSON.parse(message);
        this.server.to(room).emit(payload.kind, payload.data);
      } catch (e) {
        this.log.warn(`pubsub decode err: ${(e as Error).message}`);
      }
    });
    this.log.log('subscribed to Redis pattern md:*');
  }

  handleConnection(client: Socket) {
    this.log.debug(`ws connect ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.log.debug(`ws disconnect ${client.id}`);
  }

  @SubscribeMessage('subscribe')
  async onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { symbol: string },
  ) {
    const { symbol } = body ?? {};
    if (!symbol) return { ok: false };
    for (const kind of ['trade', 'orderbook', 'candle']) {
      client.join(`md:${symbol}:${kind}`);
    }
    // Snapshot pull from Redis SET — the matcher keeps this fresh.
    const snapshot = await this.snapshotCache.getOrderbook(symbol);
    if (snapshot) {
      client.emit('orderbook', snapshot);
    } else {
      // Empty book — matcher hasn't published yet (cold start). Client UI
      // will fill in once the first orderbook tick arrives via pub/sub.
      client.emit('orderbook', { symbol, asks: [], bids: [], ts: Date.now() });
    }
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  onUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { symbol: string },
  ) {
    const { symbol } = body ?? {};
    for (const kind of ['trade', 'orderbook', 'candle']) {
      client.leave(`md:${symbol}:${kind}`);
    }
    return { ok: true };
  }
}
