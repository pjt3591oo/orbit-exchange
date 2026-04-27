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
import { metrics } from '@orbit/observability';
import { REDIS_SUB } from '../redis/redis.module';
import { SnapshotCacheService } from './snapshot-cache.service';

const M = metrics.Metrics;
const NAMESPACE = 'market';

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
        // payload.kind ∈ {trade | orderbook | candle}
        M.realtimeRoomEmits.inc({ kind: String(payload.kind) });
      } catch (e) {
        this.log.warn(`pubsub decode err: ${(e as Error).message}`);
      }
    });
    this.log.log('subscribed to Redis pattern md:*');
  }

  handleConnection(client: Socket) {
    this.log.debug(`ws connect ${client.id}`);
    M.realtimeConnections.inc({ namespace: NAMESPACE });
  }

  handleDisconnect(client: Socket) {
    this.log.debug(`ws disconnect ${client.id}`);
    M.realtimeConnections.dec({ namespace: NAMESPACE });
  }

  /**
   * Subscribe a client to a market's data rooms. `kind` lets callers pick
   * which streams they actually want — important because:
   *
   *   - The market-list side panel only needs trade ticks, but if it joined
   *     the orderbook room too the gateway would `emit('orderbook', ...)`
   *     back on every subscribe call, **clobbering** the trade page's
   *     populated orderbook with an empty one whenever the snapshot SET
   *     happens to be missing (e.g. matcher idle longer than the TTL).
   *   - The orderbook panel wants the snapshot push on subscribe; the
   *     trades tape doesn't.
   *
   * `kind: 'all'` (default) preserves prior behaviour for clients that
   * still send the old `{symbol}` payload.
   */
  @SubscribeMessage('subscribe')
  async onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { symbol: string; kind?: 'trade' | 'orderbook' | 'candle' | 'all' },
  ) {
    const { symbol, kind = 'all' } = body ?? {};
    if (!symbol) return { ok: false };
    const kinds =
      kind === 'all' ? (['trade', 'orderbook', 'candle'] as const) : ([kind] as const);
    for (const k of kinds) client.join(`md:${symbol}:${k}`);

    // Only push a snapshot if the caller asked for orderbook updates AND we
    // actually have one. Emitting an empty payload here is what was nuking
    // the panel — the client already starts with an empty book by default,
    // and the next pub/sub tick will fill it.
    if ((kind === 'all' || kind === 'orderbook')) {
      const snapshot = await this.snapshotCache.getOrderbook(symbol);
      if (snapshot) client.emit('orderbook', snapshot);
    }
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  onUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { symbol: string; kind?: 'trade' | 'orderbook' | 'candle' | 'all' },
  ) {
    const { symbol, kind = 'all' } = body ?? {};
    if (!symbol) return { ok: false };
    const kinds =
      kind === 'all' ? (['trade', 'orderbook', 'candle'] as const) : ([kind] as const);
    for (const k of kinds) client.leave(`md:${symbol}:${k}`);
    return { ok: true };
  }
}
