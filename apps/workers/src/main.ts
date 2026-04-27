// IMPORTANT: tracing first.
import { tracing, metrics, startOpsServer } from '@orbit/observability';
tracing.startTracing('orbit-workers');
metrics.bindMetrics('orbit-workers');

import { runCandleAggregator } from './candle-aggregator';
import { runMarketDataFanout } from './market-data-fanout';
import { runNotification } from './notification';
import { runAuditLogger } from './audit-logger';
import { runOutboxRelay } from './outbox-relay';
import { runRetry30s } from './retry-30s';
import { runDlqMonitor } from './dlq-monitor';
import { logger } from './lib/logger';

async function main() {
  const enabled = (
    process.env.WORKERS ??
    'candle,fanout,notification,audit,outbox-relay,retry-30s,dlq-monitor'
  ).split(',').map((s) => s.trim());
  logger.info({ enabled }, 'starting workers');

  const opsPort = Number(process.env.WORKERS_OPS_PORT ?? 3003);
  const ops = startOpsServer({
    port: opsPort,
    health: () => ({ workers: enabled }),
    // ADR-0001 §D3 — workers /ready is a placeholder until ADR-0005
    // splits each worker into its own container. Once that lands, the
    // probe per container will assert that THIS specific consumer has
    // joined its group. For now, "we have at least one worker enabled"
    // is the strongest assertion we can make at this layer.
    ready: () => ({
      ready: enabled.length > 0,
      details: { hasEnabledWorkers: enabled.length > 0 },
    }),
  });
  process.once('SIGTERM', () => ops.close());
  process.once('SIGINT', () => ops.close());

  const tasks: Array<Promise<void>> = [];
  if (enabled.includes('candle')) tasks.push(runCandleAggregator());
  if (enabled.includes('fanout')) tasks.push(runMarketDataFanout());
  if (enabled.includes('notification')) tasks.push(runNotification());
  if (enabled.includes('audit')) tasks.push(runAuditLogger());
  // ADR-0002: drains OutboxEvent rows produced by api/matcher into Kafka.
  if (enabled.includes('outbox-relay')) tasks.push(runOutboxRelay());
  // ADR-0004: 30-second retry tier — bounce transient failures back to
  // their original topic after a delay.
  if (enabled.includes('retry-30s')) tasks.push(runRetry30s());
  // ADR-0004: mirror DLQ messages into Postgres for the admin UI.
  if (enabled.includes('dlq-monitor')) tasks.push(runDlqMonitor());
  await Promise.all(tasks);
}

main().catch((err) => {
  logger.error({ err }, 'worker bootstrap failed');
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
