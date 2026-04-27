/**
 * Builds the `pino` transport config for an ORBIT app:
 *   - dev   → pino-pretty (stdout) + pino-loki (HTTP push)
 *   - prod  → JSON to stdout + pino-loki
 *
 * Usage:
 *   LoggerModule.forRoot({
 *     pinoHttp: {
 *       mixin: pinoOtelMixin,
 *       transport: pinoTransport('orbit-api'),
 *     }
 *   })
 *
 * Loki URL is from LOKI_URL env (default http://localhost:3100). On 5xx
 * pino-loki retries internally; on connection refused (Loki down at boot)
 * the transport silently retries every 5s — no app crash.
 */
import type { TransportMultiOptions, TransportTargetOptions } from 'pino';

export function pinoTransport(serviceName: string): TransportMultiOptions {
  const lokiUrl = process.env.LOKI_URL ?? 'http://localhost:3100';
  const env = process.env.NODE_ENV ?? 'development';

  const targets: TransportTargetOptions[] = [
    // pino-loki: HTTP push to Loki. Always on (dev + prod).
    {
      target: 'pino-loki',
      level: 'info',
      options: {
        host: lokiUrl,
        batching: true,
        interval: 2,                  // seconds — flush every 2s
        replaceTimestamp: true,       // align with Loki's clock
        labels: { service: serviceName, env },
      },
    },
  ];

  if (env !== 'production') {
    // Pretty stdout for the developer.
    targets.push({
      target: 'pino-pretty',
      level: 'debug',
      options: { singleLine: true },
    });
  } else {
    // Plain JSON stdout for prod (CloudWatch agent etc. picks it up too).
    targets.push({
      target: 'pino/file',
      level: 'info',
      options: { destination: 1 },    // 1 = stdout
    });
  }

  return { targets };
}
