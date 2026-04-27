/**
 * Worker-side dedupe wrapper for at-least-once delivery scenarios. The
 * outbox relay (ADR-0002) and ordinary Kafka rebalances both produce
 * duplicate event delivery; consumers wrap their handler with `withDedupe`
 * to make processing effectively-once.
 *
 * Why Redis SETNX vs a Postgres unique table:
 *
 *   Workers like notification / market-data-fanout don't write any persisted
 *   row that has a natural unique constraint. Their side effect is an
 *   external API call (SNS publish) or an in-memory pub/sub fanout. We need
 *   a separate dedupe ledger that:
 *     1. is fast (these workers run on the hot path),
 *     2. is short-lived (the duplicate window is rebalance/replay scale —
 *        seconds to minutes, not days),
 *     3. is shared across worker replicas.
 *
 *   Redis SET NX with TTL satisfies all three — see ADR-0003 §D4.
 *
 * Failure modes:
 *
 *   - On Redis disconnect: the SET fails → handler is treated as "miss" and
 *     runs anyway. Better duplicate side-effect than dropped event.
 *   - On handler throw: the dedupe key is deleted, allowing the next
 *     redelivery to retry. Otherwise a transient external failure would
 *     poison the eventId forever.
 *
 * Usage:
 *
 *   await withDedupe(redis, ev.eventId, 'notification', 3600, async () => {
 *     await sns.publish(...);
 *   });
 */
import { Metrics } from './metrics.js';

/**
 * Structural subset of ioredis we actually use. Defined here so this
 * package doesn't take a hard dependency on ioredis — callers pass their
 * own Redis client.
 */
export interface DedupeRedis {
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSec: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  del(key: string): Promise<number>;
}

/**
 * Returns the result of `fn()` on cache miss, or `null` on cache hit
 * (caller treats `null` as "already processed, skip side effects").
 */
export async function withDedupe<T>(
  redis: DedupeRedis,
  eventId: string | undefined,
  worker: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  // No eventId → cannot dedupe; degrade to executing the handler.
  // The producer side should always set one, but old messages on the topic
  // pre-migration won't have it. Treating those as misses preserves
  // backward compatibility.
  if (!eventId) {
    Metrics.dedupeMiss.inc({ worker });
    return await fn();
  }

  const key = `dedupe:${worker}:${eventId}`;
  let acquired: 'OK' | null;
  try {
    acquired = await redis.set(key, '1', 'EX', ttlSec, 'NX');
  } catch {
    // Redis down — fail open (run handler) rather than fail closed (skip).
    Metrics.dedupeMiss.inc({ worker });
    return await fn();
  }

  if (acquired !== 'OK') {
    Metrics.dedupeHit.inc({ worker });
    return null;
  }

  Metrics.dedupeMiss.inc({ worker });
  try {
    return await fn();
  } catch (err) {
    // Don't let a transient failure poison the eventId forever — release
    // the dedupe key so the next redelivery can retry.
    try {
      await redis.del(key);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
