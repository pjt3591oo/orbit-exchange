import { Controller, Get } from '@nestjs/common';

/**
 * Minimal health endpoint. The realtime service is HTTP-light; we only
 * expose `/health` so that load balancers / k8s probes can verify the
 * process is alive (the WS upgrade goes through the same port).
 */
@Controller({ path: 'health' })
export class HealthController {
  @Get()
  ok() {
    return { ok: true, ts: Date.now() };
  }
}
