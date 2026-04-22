import { runCandleAggregator } from './candle-aggregator';
import { runMarketDataFanout } from './market-data-fanout';
import { runNotification } from './notification';
import { runAuditLogger } from './audit-logger';
import { logger } from './lib/logger';

async function main() {
  const enabled = (process.env.WORKERS ?? 'candle,fanout,notification,audit').split(',').map((s) => s.trim());
  logger.info({ enabled }, 'starting workers');
  const tasks: Array<Promise<void>> = [];
  if (enabled.includes('candle')) tasks.push(runCandleAggregator());
  if (enabled.includes('fanout')) tasks.push(runMarketDataFanout());
  if (enabled.includes('notification')) tasks.push(runNotification());
  if (enabled.includes('audit')) tasks.push(runAuditLogger());
  await Promise.all(tasks);
}

main().catch((err) => {
  logger.error({ err }, 'worker bootstrap failed');
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
