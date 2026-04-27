/**
 * @orbit/observability — shared LGTM-stack glue for ORBIT user services
 * (api / matcher / realtime / workers).
 *
 * Per-target imports (do NOT import everything from `.`):
 *   - `@orbit/observability/tracing` — load FIRST in main.ts (initialises OTel
 *     SDK before any other module wraps prisma/kafkajs/ioredis).
 *   - `@orbit/observability/metrics` — prom-client registry + helpers used in
 *     services that record custom metrics.
 *   - `@orbit/observability/pino-otel` — pino formatter that injects
 *     trace_id / span_id from active OTel context.
 *   - `@orbit/observability/nest` — NestJS module that exposes /metrics on
 *     the app's HTTP server (or a dedicated ops server).
 */
export * as tracing from './tracing.js';
export * as metrics from './metrics.js';
export * from './metric-names.js';
export * from './nest.js';
export * from './pino-otel.js';
export * from './pino-transport.js';
export * from './kafka-trace.js';
export * from './dedupe.js';
export * from './retry-policy.js';
