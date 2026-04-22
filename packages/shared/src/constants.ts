export const KAFKA_TOPICS = {
  TRADES: 'orbit.trades.v1',
  ORDERS: 'orbit.orders.v1',
  ORDERBOOK: 'orbit.orderbook.v1',
  USER_EVENTS: 'orbit.user-events.v1',
  DLQ: 'orbit.dlq.v1',
} as const;

export const CONSUMER_GROUPS = {
  CANDLE_AGGREGATOR: 'orbit.candle-aggregator',
  MARKET_DATA_FANOUT: 'orbit.market-data-fanout',
  NOTIFICATION: 'orbit.notification',
  AUDIT_LOGGER: 'orbit.audit-logger',
} as const;

export const REDIS_CHANNELS = {
  MARKET_DATA: (symbol: string) => `md:${symbol}`,
  USER_STREAM: (userId: string) => `user:${userId}`,
} as const;

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
