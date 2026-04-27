/**
 * Kafka consumer ↔ OTel context bridge.
 *
 * Why this exists:
 *
 *   The kafkajs auto-instrumentation that ships with
 *   @opentelemetry/auto-instrumentations-node does inject `traceparent` into
 *   message headers on the producer side, and creates a span on
 *   `eachMessage`. But it does NOT always activate the propagated parent
 *   context for the duration of the handler — meaning any subsequent
 *   redis.publish / prisma query / SNS call inside the handler shows up as
 *   a ROOT span in Tempo, breaking the service-graph chain.
 *
 *   This helper:
 *     1. extracts the W3C traceparent from message.headers (if present)
 *     2. activates that context
 *     3. starts a CONSUMER span (`<topic> process`) as the child
 *     4. runs the handler inside that span — every span the handler creates
 *        becomes a descendant, and Tempo's metrics_generator can stitch the
 *        full chain (producer → consumer → downstream) in the service graph
 *     5. records exception + sets STATUS_CODE_ERROR on throw
 *
 * Usage:
 *   await consumer.run({
 *     eachMessage: (payload) => withKafkaContext(
 *       { worker: 'market-data-fanout', topic: payload.topic, message: payload.message },
 *       async () => {
 *         // your handler body — every span here is a descendant of the producer
 *       },
 *     ),
 *   });
 */
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
} from '@opentelemetry/api';
import type { KafkaMessage } from 'kafkajs';

/** kafkajs message headers can be Buffer | string | (Buffer|string)[] | undefined */
const headerGetter: TextMapGetter<Record<string, unknown> | undefined> = {
  get(carrier, key) {
    if (!carrier) return undefined;
    const raw = (carrier as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) return undefined;
    if (Array.isArray(raw)) {
      const first = raw[0];
      return typeof first === 'string' ? first : (first as Buffer)?.toString();
    }
    if (typeof raw === 'string') return raw;
    if (Buffer.isBuffer(raw)) return raw.toString();
    return String(raw);
  },
  keys(carrier) {
    return carrier ? Object.keys(carrier) : [];
  },
};

export interface KafkaContextInput {
  /** Logical worker / consumer name — used as span attribute + service graph label */
  worker: string;
  /** Kafka topic */
  topic: string;
  /** kafkajs message — header source for traceparent extraction */
  message: Pick<KafkaMessage, 'headers' | 'offset'>;
  /** Optional partition (lives on EachMessagePayload, not the message itself) */
  partition?: number;
}

export async function withKafkaContext<T>(
  input: KafkaContextInput,
  fn: () => Promise<T>,
): Promise<T> {
  // 1. Pull traceparent (and tracestate, baggage) from message headers.
  const parentCtx = propagation.extract(
    context.active(),
    (input.message.headers ?? {}) as Record<string, unknown>,
    headerGetter,
  );

  // 2. Start a CONSUMER span. Naming convention follows OTel SemConv for
  //    messaging: `<destination> <operation>` → "<topic> process".
  const tracer = trace.getTracer('@orbit/observability/kafka');
  return await context.with(parentCtx, () =>
    tracer.startActiveSpan(
      `${input.topic} process`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'kafka',
          'messaging.destination.name': input.topic,
          'messaging.operation': 'process',
          'messaging.kafka.consumer.group': input.worker,
          ...(input.partition !== undefined && {
            'messaging.kafka.partition': input.partition,
          }),
          ...(input.message.offset !== undefined && {
            'messaging.kafka.message.offset': String(input.message.offset),
          }),
          'orbit.worker': input.worker,
        },
      },
      async (span) => {
        try {
          const out = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return out;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error).message,
          });
          throw err;
        } finally {
          span.end();
        }
      },
    ),
  );
}
