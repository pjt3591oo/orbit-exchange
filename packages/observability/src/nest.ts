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
 * Standalone http server for matcher/workers: serves only /metrics + /health.
 * Returns the server so callers can close() on shutdown.
 */
export function startOpsServer(opts: {
  port: number;
  health?: () => Record<string, unknown>;
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
      res.statusCode = 404;
      res.end('not found');
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  server.listen(opts.port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[ops] /metrics + /health listening on :${opts.port}`);
  });
  return server;
}
