/**
 * OpenTelemetry SDK initialiser.
 *
 * Load this FIRST in your app's main.ts:
 *
 *   import { startTracing } from '@orbit/observability/tracing';
 *   startTracing('orbit-api');         // sets service.name resource attr
 *   import './app.module';             // ← only AFTER tracing is up
 *
 * The startTracing() call must run before any module that wraps a library
 * we want auto-instrumented (HTTP, prisma, kafkajs, ioredis) is `require`d —
 * otherwise the auto-instrumentations don't latch on.
 *
 * Configuration (env):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  default http://localhost:4317
 *   OTEL_SERVICE_NAME            override service name
 *   OTEL_TRACES_SAMPLER_ARG      0.0–1.0 (default 1.0 = sample all)
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

// String keys instead of importing semantic-conventions/incubating — that
// subpath has churned across versions, so we hard-code the well-known names.
const ATTR_SERVICE_NAME = 'service.name';
const ATTR_SERVICE_VERSION = 'service.version';
const ATTR_DEPLOYMENT_ENV = 'deployment.environment.name';

let started = false;
let sdk: NodeSDK | null = null;

export function startTracing(serviceName: string): void {
  if (started) return;
  started = true;

  const samplerArg = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? '1.0');
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317';
  const env = process.env.NODE_ENV ?? 'development';

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
      [ATTR_DEPLOYMENT_ENV]: env,
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    sampler: new TraceIdRatioBasedSampler(Math.max(0, Math.min(1, samplerArg))),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem spans are noise — every readFile call would create a span.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Don't trace OTel's own HTTP push to Tempo (would loop).
        '@opentelemetry/instrumentation-http': {
          ignoreOutgoingRequestHook: (req) => {
            const host = req.hostname ?? '';
            return host.includes('tempo') || host.includes('loki');
          },
          // Skip noisy local probes.
          ignoreIncomingRequestHook: (req) => {
            const url = req.url ?? '';
            return url === '/metrics' || url === '/health';
          },
        },
      }),
    ],
  });

  sdk.start();

  // Graceful flush on exit so we don't lose the last few spans.
  const shutdown = async () => {
    try {
      await sdk?.shutdown();
    } catch {
      /* ignore */
    }
  };
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
}

export function shutdownTracing(): Promise<void> {
  return sdk?.shutdown() ?? Promise.resolve();
}
