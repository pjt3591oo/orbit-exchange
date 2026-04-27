/**
 * Shared prom-client registry + the ORBIT custom business metrics.
 *
 * Each app calls `bindMetrics(serviceName)` exactly once during boot to set
 * default labels. After that, services anywhere in the codebase can just
 *   import { Metrics } from '@orbit/observability/metrics';
 *   Metrics.ordersSubmitted.inc({ market, side, type, result: 'ok' });
 *
 * The registry is exposed via getRegistry() for the /metrics HTTP endpoint
 * (see ./nest.ts for the NestJS module that wires it).
 */
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
} from 'prom-client';

const registry = new Registry();
let bound = false;

/** Call once at boot. Adds the `service` default label + node default metrics. */
export function bindMetrics(serviceName: string): void {
  if (bound) return;
  bound = true;
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({
    register: registry,
    // Drop noisy / costly defaults; keep CPU + heap + eventloop lag + GC.
    eventLoopMonitoringPrecision: 100,
  });
}

export function getRegistry(): Registry {
  return registry;
}

/* ───────────── Custom business metrics (singletons) ───────────── */

// Buckets tuned for HTTP / Kafka / matcher latencies in ms.
const SHORT_BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2500];

export const Metrics = {
  /* Order pipeline ------------------------------------------------ */
  ordersSubmitted: new Counter({
    name: 'orbit_orders_submitted_total',
    help: 'Orders accepted by api (one per OPEN row written).',
    labelNames: ['market', 'side', 'type', 'result'] as const,
    registers: [registry],
  }),
  orderSubmitDuration: new Histogram({
    name: 'orbit_order_submit_duration_ms',
    help: 'POST /orders end-to-end duration including DB lock+insert+kafka publish.',
    labelNames: ['market'] as const,
    buckets: SHORT_BUCKETS_MS,
    registers: [registry],
  }),
  ordersCancelled: new Counter({
    name: 'orbit_orders_cancelled_total',
    help: 'CANCEL commands published (api or admin force-cancel).',
    labelNames: ['market', 'origin'] as const,    // origin = user | admin
    registers: [registry],
  }),
  frozenBlocks: new Counter({
    name: 'orbit_frozen_blocks_total',
    help: 'Order submissions blocked because the user is frozen.',
    registers: [registry],
  }),

  /* Matcher ------------------------------------------------------- */
  matcherSettleDuration: new Histogram({
    name: 'orbit_matcher_settle_duration_ms',
    help: 'Settlement transaction duration in matcher (per command).',
    labelNames: ['symbol', 'cmdType'] as const,   // cmdType = SUBMIT | CANCEL
    buckets: SHORT_BUCKETS_MS,
    registers: [registry],
  }),
  matcherTradesExecuted: new Counter({
    name: 'orbit_trades_executed_total',
    help: 'Trades produced by the matcher.',
    labelNames: ['market', 'taker_side'] as const,
    registers: [registry],
  }),
  matcherQueueDepth: new Gauge({
    name: 'orbit_matcher_queue_depth',
    help: 'Per-market p-queue pending command count (concurrency=1).',
    labelNames: ['symbol'] as const,
    registers: [registry],
  }),
  matcherBookLevels: new Gauge({
    name: 'orbit_orderbook_depth_levels',
    help: 'Orderbook level count per side (matcher in-memory).',
    labelNames: ['market', 'side'] as const,
    registers: [registry],
  }),
  matcherCommandsConsumed: new Counter({
    name: 'orbit_order_commands_consumed_total',
    help: 'Commands the matcher pulled off Kafka and processed.',
    labelNames: ['cmdType', 'result'] as const,   // result = ok | noop | error
    registers: [registry],
  }),

  /* Kafka producer ----------------------------------------------- */
  kafkaPublishDuration: new Histogram({
    name: 'orbit_kafka_publish_duration_ms',
    help: 'Producer.send() duration per message.',
    labelNames: ['topic', 'result'] as const,     // result = ok | error
    buckets: SHORT_BUCKETS_MS,
    registers: [registry],
  }),

  /* Realtime ----------------------------------------------------- */
  realtimeConnections: new Gauge({
    name: 'orbit_realtime_active_connections',
    help: 'Open Socket.IO connections per namespace.',
    labelNames: ['namespace'] as const,
    registers: [registry],
  }),
  realtimeRoomEmits: new Counter({
    name: 'orbit_realtime_room_emit_total',
    help: 'Number of room emits (one per pub/sub message fanout).',
    labelNames: ['kind'] as const,                // kind = trade | orderbook | candle
    registers: [registry],
  }),

  /* Workers ------------------------------------------------------ */
  workerMessagesProcessed: new Counter({
    name: 'orbit_worker_messages_processed_total',
    help: 'Kafka messages consumed by workers.',
    labelNames: ['worker', 'topic', 'result'] as const,  // result = ok | error
    registers: [registry],
  }),
  workerHandlerDuration: new Histogram({
    name: 'orbit_worker_handler_duration_ms',
    help: 'Per-message handler execution time.',
    labelNames: ['worker'] as const,
    buckets: SHORT_BUCKETS_MS,
    registers: [registry],
  }),

  /* Outbox (ADR-0002) ------------------------------------------- */
  outboxAppended: new Counter({
    name: 'orbit_outbox_appended_total',
    help: 'OutboxEvent rows inserted by producers (api/matcher) inside their transactions.',
    labelNames: ['topic'] as const,
    registers: [registry],
  }),
  outboxPending: new Gauge({
    name: 'orbit_outbox_pending_count',
    help: 'Outbox rows with processedAt IS NULL (relay backlog).',
    labelNames: ['topic'] as const,
    registers: [registry],
  }),
  outboxOldestAge: new Gauge({
    name: 'orbit_outbox_oldest_age_seconds',
    help: 'Age of the oldest unprocessed outbox row in seconds.',
    labelNames: ['topic'] as const,
    registers: [registry],
  }),
  outboxRelayPublished: new Counter({
    name: 'orbit_outbox_relay_published_total',
    help: 'Outbox rows successfully published to Kafka by the relay.',
    labelNames: ['topic', 'result'] as const, // result = ok | error
    registers: [registry],
  }),
  outboxRelayPublishDuration: new Histogram({
    name: 'orbit_outbox_relay_publish_duration_ms',
    help: 'producer.send() latency observed by the outbox relay.',
    labelNames: ['topic'] as const,
    buckets: SHORT_BUCKETS_MS,
    registers: [registry],
  }),

  /* Idempotency (ADR-0003) -------------------------------------- */
  idempotencyHit: new Counter({
    name: 'orbit_idempotency_hit_total',
    help: 'HTTP requests served from the IdempotencyKey cache (key+body match).',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  }),
  idempotencyMiss: new Counter({
    name: 'orbit_idempotency_miss_total',
    help: 'HTTP requests where Idempotency-Key was new — handler executed.',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  }),
  idempotencyConflict: new Counter({
    name: 'orbit_idempotency_conflict_total',
    help: 'Idempotency-Key reused with a different body — 409 returned.',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  }),
  dedupeHit: new Counter({
    name: 'orbit_dedupe_hit_total',
    help: 'Worker-side dedupe — eventId already seen, handler skipped.',
    labelNames: ['worker'] as const,
    registers: [registry],
  }),
  dedupeMiss: new Counter({
    name: 'orbit_dedupe_miss_total',
    help: 'Worker-side dedupe — eventId fresh, handler executed.',
    labelNames: ['worker'] as const,
    registers: [registry],
  }),
};
