export const KAFKA_TOPICS = {
  /**
   * Commands flowing API → Matcher. Commands describe intent ("submit this
   * order", "cancel this order"). Partitioned by symbol so the matcher
   * receives all events for one market in order on a single partition.
   */
  ORDER_COMMANDS: 'orbit.order-commands.v1',
  /** Events Matcher → workers / fanout. Trade fills, order state updates. */
  TRADES: 'orbit.trades.v1',
  ORDERS: 'orbit.orders.v1',
  ORDERBOOK: 'orbit.orderbook.v1',
  USER_EVENTS: 'orbit.user-events.v1',
  /**
   * 30-second retry tier (ADR-0004 §D2). Workers republish here when
   * in-flight retries are exhausted but the error is classified as
   * transient. The retry-30s worker waits then republishes back to the
   * original topic.
   */
  RETRY_30S: 'orbit.retry.30s.v1',
  /**
   * Dead-letter queue (ADR-0004 §D2). Terminal failures land here. The
   * dlq-monitor worker mirrors these into the DlqEvent table for
   * operator inspection / replay via the admin UI.
   */
  DLQ: 'orbit.dlq.v1',
} as const;

export const CONSUMER_GROUPS = {
  /** Single matcher process (or per-shard) consuming order commands. */
  MATCHER: 'orbit.matcher',
  CANDLE_AGGREGATOR: 'orbit.candle-aggregator',
  MARKET_DATA_FANOUT: 'orbit.market-data-fanout',
  NOTIFICATION: 'orbit.notification',
  AUDIT_LOGGER: 'orbit.audit-logger',
  /** ADR-0004 — 30-second retry tier consumer. */
  RETRY_30S: 'orbit.retry-30s',
  /** ADR-0004 — DLQ → Postgres mirror for admin replay UI. */
  DLQ_MONITOR: 'orbit.dlq-monitor',
} as const;

export const REDIS_CHANNELS = {
  MARKET_DATA: (symbol: string) => `md:${symbol}`,
  USER_STREAM: (userId: string) => `user:${userId}`,
} as const;

/**
 * Redis SET keys (not pub/sub channels) for cached snapshots that new WS
 * subscribers can read once. Pub/sub is fire-and-forget; this fills the gap.
 */
export const REDIS_KEYS = {
  ORDERBOOK_SNAPSHOT: (symbol: string) => `ob:snapshot:${symbol}`,
} as const;

/**
 * TTL for orderbook snapshot cache (seconds). The matcher refreshes the SET
 * on every order/cancel/match, so during active trading the TTL never matters.
 * It only kicks in when a market is quiet for an extended period — at which
 * point the key disappears and any new subscriber sees an empty book until
 * the next event.
 *
 * Set to 24h so quiet markets stay populated; if the matcher dies the next
 * boot replays from DB and rewrites this key, so stale data is bounded by
 * matcher downtime.
 */
export const ORDERBOOK_SNAPSHOT_TTL_SEC = 86400;

export type CandleInterval = 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1' | 'W1';
export const CANDLE_INTERVAL_SECONDS: Record<CandleInterval, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  H1: 3600,
  H4: 14400,
  D1: 86400,
  W1: 604800,
};

/**
 * Only M1 is persisted today; higher intervals are derived on-the-fly from M1.
 * W1 is not in the Prisma enum since it's never written, only computed.
 */
export const PERSISTED_CANDLE_INTERVALS: CandleInterval[] = [
  'M1',
  'M5',
  'M15',
  'H1',
  'H4',
  'D1',
];
