/* eslint-disable no-console */
/**
 * scripts/grafana-reload.ts — force Grafana to re-read provisioning files
 * NOW (instead of waiting for the 30s scan). Useful right after editing a
 * dashboard JSON file by hand or after `git pull`.
 *
 *   pnpm grafana:reload
 *
 * Equivalent to: POST /api/admin/provisioning/dashboards/reload
 *                POST /api/admin/provisioning/datasources/reload
 */

const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://localhost:3030';
const GRAFANA_TOKEN = process.env.GRAFANA_TOKEN ?? '';
// Anonymous Admin in dev is read-only-ish — provisioning reload requires
// proper admin credentials. Default to admin/admin (the dev master user).
const GRAFANA_USER = process.env.GRAFANA_USER ?? 'admin';
const GRAFANA_PASS = process.env.GRAFANA_PASS ?? 'admin';

const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (GRAFANA_TOKEN) {
  headers.Authorization = `Bearer ${GRAFANA_TOKEN}`;
} else {
  headers.Authorization = `Basic ${Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64')}`;
}

async function reload(kind: 'dashboards' | 'datasources') {
  const r = await fetch(`${GRAFANA_URL}/api/admin/provisioning/${kind}/reload`, {
    method: 'POST',
    headers,
  });
  const body = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`reload ${kind}: ${r.status} ${body}`);
  console.log(`  ✓ ${kind} reloaded — ${body}`);
}

async function main() {
  console.log(`[grafana-reload] target=${GRAFANA_URL}`);
  await reload('datasources');
  await reload('dashboards');
  console.log('[grafana-reload] done');
}

main().catch((e) => {
  console.error('[grafana-reload] failed:', e);
  process.exit(1);
});
