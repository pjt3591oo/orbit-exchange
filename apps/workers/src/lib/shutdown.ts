/**
 * ADR-0005 §D6 — graceful shutdown for plain-script workers.
 *
 * NestJS apps get this for free via app.enableShutdownHooks(); this helper
 * is for the workers main.ts which is a plain Node script.
 *
 * On SIGTERM (k8s pod stop, docker stop):
 *   1. mark shutting-down (so subsequent signals are ignored)
 *   2. run each disposer with a 30s timeout
 *   3. process.exit(0)
 *
 * Each disposer typically calls `consumer.stop()` / `producer.disconnect()`
 * / `prisma.$disconnect()`. They must be idempotent — multi-second SIGTERM
 * windows can result in a second signal arriving while disposers run.
 */
import { logger } from './logger';

const DISPOSE_TIMEOUT_MS = 30_000;

export type Disposer = () => Promise<void> | void;

let installed = false;
let shuttingDown = false;
const disposers: Disposer[] = [];

/** Register a disposer to run on graceful shutdown. Order: LIFO. */
export function onShutdown(d: Disposer): void {
  disposers.unshift(d);
  if (!installed) install();
}

function install() {
  installed = true;
  const handler = (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second shutdown signal ignored — already shutting down');
      return;
    }
    shuttingDown = true;
    void runDisposers(signal);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

async function runDisposers(signal: string) {
  logger.info({ signal, count: disposers.length }, 'shutdown — running disposers');
  for (const d of disposers) {
    try {
      await Promise.race([
        Promise.resolve(d()),
        sleep(DISPOSE_TIMEOUT_MS).then(() => {
          throw new Error(`disposer timed out after ${DISPOSE_TIMEOUT_MS}ms`);
        }),
      ]);
    } catch (err) {
      logger.error({ err }, 'disposer failed');
    }
  }
  logger.info('shutdown complete');
  // Give the logger a moment to flush, then exit.
  setTimeout(() => process.exit(0), 100).unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
