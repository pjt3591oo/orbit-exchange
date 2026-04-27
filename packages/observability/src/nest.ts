/**
 * /metrics + /health helpers.
 *
 * Two integration modes:
 *
 * (A) The app already has an HTTP server (api, realtime). Pass the handler
 *     to whatever http stack is in use:
 *
 *       app.use('/metrics', metricsHandler);   // express
 *       fastify.get('/metrics', metricsHandler);
 *
 *     The handler signature is generic: `(req, res) => Promise<void>` and
 *     uses only Node's built-in http types.
 *
 * (B) The app is HTTP-less (matcher, workers): start a tiny standalone
 *     server with startOpsServer({ port }).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getRegistry } from './metrics.js';

export type ProbeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

export const metricsHandler: ProbeHandler = async (_req, res) => {
  try {
    const reg = getRegistry();
    res.setHeader('Content-Type', reg.contentType);
    res.end(await reg.metrics());
  } catch (err) {
    res.statusCode = 500;
    res.end(`# metrics error: ${(err as Error).message}`);
  }
};

export function makeHealthHandler(extra?: () => Record<string, unknown>): ProbeHandler {
  return (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        ts: new Date().toISOString(),
        ...(extra?.() ?? {}),
      }),
    );
  };
}

/**
 * Result of a `/ready` probe — see ADR-0001 §D3.
 *
 * `ready: true` means the process can accept traffic. Any individual
 * sub-check failing flips it to false, with `details` carrying the
 * per-check status so operators can see which dependency is unhealthy.
 *
 * `/health` is a separate, much weaker check — it's a liveness probe
 * (process responds at all). Container orchestrators use /health to
 * decide when to restart, /ready to decide when to route traffic.
 */
export interface ReadinessReport {
  ready: boolean;
  details: Record<string, boolean>;
}

export type ReadinessProbe = () => Promise<ReadinessReport> | ReadinessReport;

/**
 * Standalone http server for matcher/workers: serves /metrics, /health, /ready.
 * Returns the server so callers can close() on shutdown.
 *
 * - `/health` is liveness: returns 200 as long as the process is alive.
 * - `/ready` is readiness: returns 200 only when the readiness probe
 *   reports all sub-checks passing. Used by load balancers / k8s to
 *   gate traffic during cold start (e.g. matcher hasn't finished its
 *   `replayOpenOrders()` yet). Defaults to "always ready" if no probe
 *   is supplied — backward compatible with services that haven't
 *   wired readiness yet.
 */
export function startOpsServer(opts: {
  port: number;
  health?: () => Record<string, unknown>;
  ready?: ReadinessProbe;
}): import('node:http').Server {
  const reg = getRegistry();
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', reg.contentType);
        res.end(await reg.metrics());
        return;
      }
      if (req.url === '/health' || req.url === '/') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            ts: new Date().toISOString(),
            ...(opts.health?.() ?? {}),
          }),
        );
        return;
      }
      if (req.url === '/ready') {
        const report: ReadinessReport = opts.ready
          ? await opts.ready()
          : { ready: true, details: {} };
        res.statusCode = report.ready ? 200 : 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...report, ts: new Date().toISOString() }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  server.listen(opts.port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[ops] /metrics + /health + /ready listening on :${opts.port}`);
  });
  return server;
}
