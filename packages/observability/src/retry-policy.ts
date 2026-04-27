/**
 * Worker-side retry & DLQ policy (ADR-0004).
 *
 * Three tiers of failure handling for Kafka consumers:
 *
 *   1. In-flight retry — kafkajs naturally re-consumes a message when the
 *      handler throws. We let this happen up to N times by reading the
 *      `x-orbit-attempt` header.
 *
 *   2. Tier-2 retry topic — when in-flight retries are exhausted AND the
 *      error is classified transient (5xx / timeout / network), the
 *      message is republished to `orbit.retry.30s.v1` with the original
 *      headers + an `x-orbit-retry-after` timestamp. The retry-30s worker
 *      waits then republishes to the original topic. This gets the bad
 *      message out of the main consumer's hot path so other messages
 *      can flow.
 *
 *   3. DLQ — permanent errors (4xx, schema failures) skip the retry tier
 *      and go straight to `orbit.dlq.v1`. Same for transient errors that
 *      have already cycled through the retry tier once.
 *
 * In all three cases, the main consumer's offset advances — the failed
 * message is no longer the consumer's problem.
 *
 * Usage:
 *
 *   await consumer.run({
 *     eachMessage: ({ topic, partition, message }) =>
 *       withKafkaContext(..., async () => {
 *         await withRetryPolicy(
 *           { worker: 'notification', producer },
 *           { topic, partition, message },
 *           async () => {
 *             // your handler — throw on failure
 *           },
 *         );
 *       }),
 *   });
 */
import type { KafkaMessage, Producer } from 'kafkajs';
import { Metrics } from './metrics.js';

const DEFAULT_INFLIGHT_ATTEMPTS = 2;
const DEFAULT_RETRY_TOPIC = 'orbit.retry.30s.v1';
const DEFAULT_DLQ_TOPIC = 'orbit.dlq.v1';
const DEFAULT_RETRY_DELAY_MS = 30_000;

/**
 * Per-process map of in-flight kafkajs retries, keyed by
 * `<worker>:<topic>:<partition>:<offset>`.
 *
 * Why we need this: kafkajs re-consumes a message when `eachMessage`
 * throws, but it does NOT mutate the message headers between retries.
 * Without an external counter, `parseAttempt(ctx.message)` always reads
 * `x-orbit-attempt: 0` for the same message and the in-flight check
 * `attempt < inFlight` stays true forever — infinite loop, escalation
 * never fires.
 *
 * The map entry is removed on:
 *   - successful handler return (the message is fine, no follow-up needed)
 *   - escalation to retry-30s / DLQ (the offset will advance and we'll
 *     never see this exact (topic, partition, offset) tuple again on this
 *     consumer)
 *
 * Bound: |map| ≤ |currently-failing messages|. Realistic upper bound
 * during a brief outage = consumer batch size × per-partition concurrency,
 * so a few thousand keys at most.
 *
 * Process restart: counter resets — that is OK. After restart the message
 * gets one fresh round of in-flight retries before escalating, which is
 * the desired behaviour (a process restart is itself a "transient" event
 * the operator might want to ride through).
 */
const inflightCount = new Map<string, number>();

export interface RetryPolicyConfig {
  /** Worker name for metric labels and DLQ provenance. */
  worker: string;
  /** kafkajs Producer instance — caller is responsible for connect/disconnect. */
  producer: Producer;
  /**
   * Max in-flight attempts before escalating to retry/DLQ. Default 2 —
   * the very first try plus one immediate retry. Higher values keep the
   * bad message blocking the main consumer for longer.
   */
  inFlightAttempts?: number;
  retryTopic?: string;
  dlqTopic?: string;
  /** Delay applied to retry-tier messages. */
  retryDelayMs?: number;
  /**
   * Override the default error classifier. Return 'transient' to send
   * to the retry tier, 'permanent' to send straight to DLQ.
   */
  classify?: (err: unknown) => 'transient' | 'permanent';
}

export interface RetryContext {
  topic: string;
  partition: number;
  message: KafkaMessage;
}

/**
 * Wrap a consumer handler. Returns the handler's value on success, or
 * `null` if the message was escalated (retry / DLQ) — caller treats null
 * as "moved off, don't run side effects".
 */
export async function withRetryPolicy<T>(
  cfg: RetryPolicyConfig,
  ctx: RetryContext,
  fn: () => Promise<T>,
): Promise<T | null> {
  const inFlight = cfg.inFlightAttempts ?? DEFAULT_INFLIGHT_ATTEMPTS;
  const retryTopic = cfg.retryTopic ?? DEFAULT_RETRY_TOPIC;
  const dlqTopic = cfg.dlqTopic ?? DEFAULT_DLQ_TOPIC;
  const retryDelayMs = cfg.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const classify = cfg.classify ?? defaultClassify;

  // Stable identity for this specific (topic, partition, offset) on this
  // worker. Cross-worker isolation is via the worker prefix — two
  // different workers consuming the same topic each get their own count.
  const attemptKey = `${cfg.worker}:${ctx.topic}:${ctx.partition}:${ctx.message.offset}`;
  // `headerAttempt` accumulates ACROSS escalations (main → retry-30s →
  // main again). `memCount` accumulates WITHIN a single topic stay.
  // Both are summed below for the in-flight budget check.
  const headerAttempt = parseAttempt(ctx.message);

  try {
    const result = await fn();
    // Success — clear the in-flight counter so the next failure on this
    // (offset) starts fresh. If the same offset never re-appears (normal
    // path), the entry is removed here on first success.
    inflightCount.delete(attemptKey);
    return result;
  } catch (err) {
    const memCount = inflightCount.get(attemptKey) ?? 0;
    const totalAttempts = memCount + headerAttempt;

    if (totalAttempts < inFlight) {
      // Still in-flight retry budget — bump the counter and re-throw so
      // kafkajs re-consumes the same offset.
      inflightCount.set(attemptKey, memCount + 1);
      Metrics.workerRetryEnqueued.inc({ worker: cfg.worker, target: 'inflight' });
      throw err;
    }

    // Budget exhausted — escalate.
    inflightCount.delete(attemptKey);

    const errKind = classify(err);
    // First escalation of a transient error: retry-30s (give it 30s + a
    // fresh in-flight budget). Subsequent escalation (header already
    // bumped, meaning this message has cycled through retry-30s once and
    // came back failing): straight to DLQ. Permanent errors always go
    // direct to DLQ regardless of headerAttempt.
    const target =
      errKind === 'transient' && headerAttempt === 0 ? retryTopic : dlqTopic;
    const retryAfter = target === retryTopic ? Date.now() + retryDelayMs : undefined;

    try {
      await cfg.producer.send({
        topic: target,
        messages: [
          {
            key: ctx.message.key ?? undefined,
            value: ctx.message.value ?? null,
            headers: {
              ...materializeHeaders(ctx.message.headers),
              'x-orbit-original-topic': ctx.topic,
              'x-orbit-original-partition': String(ctx.partition),
              'x-orbit-original-offset': ctx.message.offset,
              // Total cycles this message has been through (including the
              // one we're now escalating from). retry-30s republishes
              // preserve this header so a subsequent failure on the
              // original topic sees a non-zero header and goes straight
              // to DLQ via the `errKind === 'transient' && header > 0`
              // dance below.
              'x-orbit-attempt': String(totalAttempts + 1),
              'x-orbit-last-error': truncate(formatError(err), 1000),
              'x-orbit-worker': cfg.worker,
              ...(retryAfter ? { 'x-orbit-retry-after': String(retryAfter) } : {}),
            },
          },
        ],
      });
      Metrics.workerRetryEnqueued.inc({ worker: cfg.worker, target });
    } catch (publishErr) {
      // If we can't even republish to retry/DLQ, rethrow the original
      // error so kafkajs replays — better duplicate work than silent loss.
      Metrics.workerRetryEnqueued.inc({ worker: cfg.worker, target: 'failed-to-enqueue' });
      throw publishErr;
    }

    // Successfully escalated — main consumer advances offset on return.
    return null;
  }
}

/* ───────────────── helpers ───────────────── */

function parseAttempt(message: KafkaMessage): number {
  const raw = readHeader(message.headers, 'x-orbit-attempt');
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function readHeader(headers: KafkaMessage['headers'], key: string): string | undefined {
  if (!headers) return undefined;
  const v = (headers as Record<string, unknown>)[key];
  if (v === undefined || v === null) return undefined;
  if (Buffer.isBuffer(v)) return v.toString();
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const first = v[0];
    if (typeof first === 'string') return first;
    if (Buffer.isBuffer(first)) return first.toString();
  }
  return undefined;
}

function materializeHeaders(
  headers: KafkaMessage['headers'],
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (Buffer.isBuffer(v)) out[k] = v.toString();
    else if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function defaultClassify(err: unknown): 'transient' | 'permanent' {
  const msg = formatError(err);
  // Heuristic ordering matters: ZodError-shaped messages, known 4xx
  // patterns first; everything else defaults to transient (safe to retry).
  if (/zod|validation|schema|invalid/i.test(msg)) return 'permanent';
  if (/\b4\d{2}\b/.test(msg) && !/429/.test(msg)) return 'permanent'; // 429 is transient (rate limit)
  if (/\b5\d{2}\b/.test(msg)) return 'transient';
  if (/timeout|econnrefused|enotfound|reset by peer|ehostunreach/i.test(msg)) return 'transient';
  return 'transient';
}

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}
