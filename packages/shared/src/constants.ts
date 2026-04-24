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
  DLQ: 'orbit.dlq.v1',
} as const;

export const CONSUMER_GROUPS = {
  /** Single matcher process (or per-shard) consuming order commands. */
  MATCHER: 'orbit.matcher',
  CANDLE_AGGREGATOR: 'orbit.candle-aggregator',
  MARKET_DATA_FANOUT: 'orbit.market-data-fanout',
  NOTIFICATION: 'orbit.notification',
  AUDIT_LOGGER: 'orbit.audit-logger',
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

/** TTL for orderbook snapshot cache (seconds). */
export const ORDERBOOK_SNAPSHOT_TTL_SEC = 60;

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
