/**
 * pino mixin/formatter helpers that pull the active OTel context and
 * inject `trace_id` / `span_id` into every log line.
 *
 * Wire it in nestjs-pino setup like:
 *
 *   LoggerModule.forRoot({
 *     pinoHttp: {
 *       mixin: pinoOtelMixin,
 *       formatters: { log: pinoOtelLogFormatter },
 *       ...
 *     }
 *   })
 *
 * Either alone is sufficient (pick one). `mixin` is the simpler path —
 * Loki's derived field then picks up `trace_id` and renders a "View trace"
 * link to Tempo.
 */
import { trace, context, isSpanContextValid } from '@opentelemetry/api';

export function pinoOtelMixin(): Record<string, string> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = span.spanContext();
  if (!isSpanContextValid(sc)) return {};
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

/** Alternative: a pino formatters.log function. */
export function pinoOtelLogFormatter(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  return { ...obj, ...pinoOtelMixin() };
}
