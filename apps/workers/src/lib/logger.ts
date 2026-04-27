import pino from 'pino';
import { pinoOtelMixin, pinoTransport } from '@orbit/observability';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Inject OTel trace_id / span_id into every line.
  mixin: pinoOtelMixin,
  transport: pinoTransport('orbit-workers'),
});

export const childLogger = (name: string) => logger.child({ worker: name });
