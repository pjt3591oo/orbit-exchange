/**
 * Stringly-typed metric name registry — handy for dashboards / alerts that
 * reference these from JSON. Keep in sync with metrics.ts.
 */
export const METRIC_NAMES = {
  ORDERS_SUBMITTED: 'orbit_orders_submitted_total',
  ORDER_SUBMIT_DURATION: 'orbit_order_submit_duration_ms',
  ORDERS_CANCELLED: 'orbit_orders_cancelled_total',
  FROZEN_BLOCKS: 'orbit_frozen_blocks_total',

  MATCHER_SETTLE_DURATION: 'orbit_matcher_settle_duration_ms',
  MATCHER_TRADES_EXECUTED: 'orbit_trades_executed_total',
  MATCHER_QUEUE_DEPTH: 'orbit_matcher_queue_depth',
  MATCHER_BOOK_LEVELS: 'orbit_orderbook_depth_levels',
  MATCHER_COMMANDS_CONSUMED: 'orbit_order_commands_consumed_total',

  KAFKA_PUBLISH_DURATION: 'orbit_kafka_publish_duration_ms',

  REALTIME_CONNECTIONS: 'orbit_realtime_active_connections',
  REALTIME_ROOM_EMITS: 'orbit_realtime_room_emit_total',

  WORKER_MESSAGES_PROCESSED: 'orbit_worker_messages_processed_total',
  WORKER_HANDLER_DURATION: 'orbit_worker_handler_duration_ms',

  // ADR-0002 outbox
  OUTBOX_APPENDED: 'orbit_outbox_appended_total',
  OUTBOX_PENDING: 'orbit_outbox_pending_count',
  OUTBOX_OLDEST_AGE: 'orbit_outbox_oldest_age_seconds',
  OUTBOX_RELAY_PUBLISHED: 'orbit_outbox_relay_published_total',
  OUTBOX_RELAY_PUBLISH_DURATION: 'orbit_outbox_relay_publish_duration_ms',

  // ADR-0003 idempotency
  IDEMPOTENCY_HIT: 'orbit_idempotency_hit_total',
  IDEMPOTENCY_MISS: 'orbit_idempotency_miss_total',
  IDEMPOTENCY_CONFLICT: 'orbit_idempotency_conflict_total',
  DEDUPE_HIT: 'orbit_dedupe_hit_total',
  DEDUPE_MISS: 'orbit_dedupe_miss_total',
} as const;
