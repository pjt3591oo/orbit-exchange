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
import { MatchingEngineService } from '../matching/matching-engine.service';

/**
 * Socket.IO gateway for market-data push.
 *
 * Subscribes to Redis pub/sub channels that the `market-data-fanout` worker
 * publishes into (upstream: Kafka → worker → Redis → all API pods → clients).
 * The API process never publishes onto these channels itself — that path is
 * reserved for workers so matching-engine latency never blocks on fanout.
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
    private readonly matching: MatchingEngineService,
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
  }

  handleConnection(client: Socket) {
    this.log.debug(`ws connect ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.log.debug(`ws disconnect ${client.id}`);
  }

  @SubscribeMessage('subscribe')
  onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { symbol: string },
  ) {
    const { symbol } = body ?? {};
    if (!symbol) return { ok: false };
    for (const kind of ['trade', 'orderbook', 'candle']) {
      client.join(`md:${symbol}:${kind}`);
    }
    // send current orderbook snapshot immediately
    try {
      const engine = this.matching.getEngine(symbol);
      const ob = engine.getOrderbook();
      client.emit('orderbook', { symbol, ...ob, ts: Date.now() });
    } catch {
      /* market may not exist */
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
