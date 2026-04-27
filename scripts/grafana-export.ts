/* eslint-disable no-console */
/**
 * scripts/grafana-export.ts — pull current Grafana dashboards back into
 * infra/grafana/dashboards/*.json so UI tweaks become git-trackable.
 *
 * Workflow:
 *   1. Edit a dashboard in Grafana UI (http://localhost:3030)
 *   2. Save (the change persists in Grafana's DB until file provisioning
 *      reconciles)
 *   3. Run `pnpm grafana:export` — overwrites the JSON file with the new
 *      panel layout / queries
 *   4. git add infra/grafana/dashboards/*.json && git commit
 *
 * Filters:
 *   - Only dashboards under the "ORBIT" folder (matches the provisioning
 *     provider name in infra/grafana/dashboards/dashboards.yml)
 *   - File name = dashboard UID (stable, kebab-cased)
 *
 * Auth: Grafana is anonymous Admin in dev (see docker-compose), so no token
 * needed. Override via GRAFANA_URL / GRAFANA_TOKEN env vars for prod.
 */
import path from 'node:path';
import fs from 'node:fs';

const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://localhost:3030';
const GRAFANA_TOKEN = process.env.GRAFANA_TOKEN ?? '';
const FOLDER = process.env.GRAFANA_FOLDER ?? 'ORBIT';

const repoRoot = (() => {
  let cur = process.cwd();
  while (cur !== '/') {
    if (fs.existsSync(path.join(cur, 'pnpm-workspace.yaml'))) return cur;
    cur = path.dirname(cur);
  }
  throw new Error(`run from inside the repo (cwd=${process.cwd()})`);
})();

const DEST_DIR = path.join(repoRoot, 'infra/grafana/dashboards');

const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (GRAFANA_TOKEN) headers.Authorization = `Bearer ${GRAFANA_TOKEN}`;

interface SearchHit {
  uid: string;
  title: string;
  type: 'dash-db' | 'dash-folder';
  folderTitle?: string;
  url: string;
}

interface DashboardWrapper {
  dashboard: Record<string, unknown> & { uid: string; title: string; id?: number; version?: number };
  meta: { folderTitle?: string; provisioned?: boolean };
}

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${GRAFANA_URL}${path}`, { headers });
  if (!r.ok) {
    throw new Error(`GET ${path} → ${r.status} ${await r.text().catch(() => '')}`);
  }
  return (await r.json()) as T;
}

/**
 * Build a uid → existing filename map by scanning existing JSON files.
 * Lets us preserve hand-picked filenames (orbit-service-overview.json)
 * even though the uid is shorter (orbit-overview).
 */
function loadExistingByUid(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(DEST_DIR)) return out;
  for (const f of fs.readdirSync(DEST_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DEST_DIR, f), 'utf8'));
      if (typeof j?.uid === 'string') out.set(j.uid, f);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

async function main() {
  console.log(`[grafana-export] source=${GRAFANA_URL}  folder="${FOLDER}"  dest=${DEST_DIR}`);

  const hits = await api<SearchHit[]>(
    `/api/search?type=dash-db&query=&limit=500`,
  );
  const targets = hits.filter(
    (h) => h.type === 'dash-db' && (h.folderTitle === FOLDER || FOLDER === '*'),
  );

  if (!targets.length) {
    console.log(`[grafana-export] no dashboards found under folder "${FOLDER}". nothing to export.`);
    return;
  }

  fs.mkdirSync(DEST_DIR, { recursive: true });
  const existing = loadExistingByUid();

  let written = 0;
  for (const hit of targets) {
    const wrapper = await api<DashboardWrapper>(`/api/dashboards/uid/${hit.uid}`);
    const d = wrapper.dashboard;

    // Strip mutable / per-instance fields. `uid` and `title` we keep —
    // those identify the dashboard.
    const stripped: Record<string, unknown> = { ...d };
    delete stripped.id;
    delete stripped.version;
    delete stripped.iteration;

    // Prefer the existing file's name (preserves hand-picked names);
    // fall back to slugified uid for brand-new dashboards.
    const fileName = existing.get(d.uid) ?? `${slugify(d.uid)}.json`;
    const fullPath = path.join(DEST_DIR, fileName);
    fs.writeFileSync(fullPath, JSON.stringify(stripped, null, 2) + '\n');
    written++;
    console.log(`  ✓ ${fileName}  (${d.title})`);
  }

  console.log(`[grafana-export] done — ${written} dashboard(s) written`);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

main().catch((e) => {
  console.error('[grafana-export] failed:', e);
  process.exit(1);
});
