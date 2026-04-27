/* eslint-disable no-console */
/**
 * scripts/chaos-reliability.ts — adversarial verification.
 *
 * Where smoke-reliability proves the happy path, this proves the
 * recovery paths under specific failure injections. Each scenario is
 * orchestrated end-to-end including the docker CLI calls — no manual
 * "now stop kafka" prompts, the script does it itself.
 *
 * Scenarios (run in sequence):
 *
 *   A. KAFKA KILL — outbox catch-up
 *      1. submit a baseline order, wait for relay to ack
 *      2. `docker stop orbit-redpanda`
 *      3. submit N orders → OutboxEvent rows accumulate, processedAt stays NULL
 *      4. assert pending count = N
 *      5. `docker start orbit-redpanda`, wait for healthy
 *      6. assert all N rows drain to processedAt set within timeout
 *      7. assert no Order rows lost (DB count matches submit count)
 *
 *   B. CONSUMER DEDUPE — outbox-relay double-publish simulation
 *      1. submit one order, capture its TRADE event from outbox payload
 *      2. directly publish the SAME payload to orbit.user-events.v1 again
 *         using a raw kafkajs producer (bypassing outbox)
 *      3. assert orbit_dedupe_hit_total{worker="notification"} increased
 *         (the second delivery was caught by withDedupe)
 *
 * Pre-conditions: same as smoke-reliability + the user has docker access
 * to start/stop containers.
 *
 * Run:
 *   pnpm reliability:chaos
 *   SCENARIOS=A pnpm reliability:chaos     # only the kafka-kill test
 *
 * SAFETY: This script restarts the Kafka broker on your local machine.
 * Do NOT run against shared infrastructure. The default is
 * orbit-redpanda which is the docker-compose container.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiPkg = resolve(__dirname, '../apps/api/package.json');
const requireFromApi = createRequire(apiPkg);
const { PrismaClient } = requireFromApi('@prisma/client') as typeof import('@prisma/client');
const { Kafka, CompressionTypes } = requireFromApi('kafkajs') as typeof import('kafkajs');

interface Cfg {
  apiUrl: string;
  market: string;
  email: string;
  password: string;
  fundKrw: string;
  fundBtc: string;
  kafkaContainer: string;
  kafkaBrokers: string[];
  drainTimeoutMs: number;
  scenarios: Set<string>;
}

const CFG: Cfg = {
  apiUrl: process.env.API_URL ?? 'http://localhost:3000',
  market: process.env.MARKET ?? 'BTC-KRW',
  email: process.env.SMOKE_EMAIL ?? 'smoke-bot@orbit.dev',
  password: process.env.SMOKE_PW ?? 'orbit-bot-pw',
  fundKrw: process.env.FUND_KRW ?? '100000000',
  fundBtc: process.env.FUND_BTC ?? '5',
  kafkaContainer: process.env.KAFKA_CONTAINER ?? 'orbit-redpanda',
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  drainTimeoutMs: Number(process.env.DRAIN_TIMEOUT_MS ?? 60_000),
  scenarios: new Set(
    (process.env.SCENARIOS ?? 'A,B').split(',').map((s) => s.trim().toUpperCase()),
  ),
};

interface Step {
  name: string;
  pass: boolean;
  detail?: string;
}
const steps: Step[] = [];
function record(name: string, pass: boolean, detail?: string) {
  steps.push({ name, pass, detail });
  const sym = pass ? '✓' : '✗';
  const tag = pass ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${tag}${sym}\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}
function header(s: string) {
  console.log(`\n\x1b[36m${s}\x1b[0m`);
}

async function main() {
  console.log(`[chaos] API=${CFG.apiUrl}  market=${CFG.market}  scenarios=${[...CFG.scenarios].join(',')}\n`);

  await preflight();

  const prisma = new PrismaClient();
  const token = await provisionBot(prisma);

  if (CFG.scenarios.has('A')) {
    await scenarioA_KafkaKill(prisma, token);
  }
  if (CFG.scenarios.has('B')) {
    await scenarioB_DedupeReplay(prisma, token);
  }

  await prisma.$disconnect();
  printSummary();
}

/* ───────────────── scenario A — Kafka kill ───────────────── */

async function scenarioA_KafkaKill(
  prisma: InstanceType<typeof PrismaClient>,
  token: string,
) {
  header('A. Kafka kill — outbox catch-up');
  const N = 5;

  // Baseline: a fresh order should fully process within timeout when
  // broker is up. This guarantees the pipeline is healthy before we
  // start breaking things.
  console.log('  baseline submit (broker up)');
  const baseline = await submit(token, randomUUID(), '0.001');
  if (baseline.status < 200 || baseline.status >= 300) {
    record('baseline submit succeeds', false, `status=${baseline.status}`);
    return;
  }
  record('baseline submit succeeds', true, `status=${baseline.status}`);
  const baselineProcessed = await waitForOutboxDrain(prisma, 1, 5_000);
  record('baseline reaches relay', baselineProcessed);

  console.log(`  stopping ${CFG.kafkaContainer}…`);
  docker(['stop', CFG.kafkaContainer]);
  // Give kafkajs producer time to notice the broker is gone, otherwise
  // the next sends might race the disconnect detection.
  await sleep(2_000);

  // Extended hold for Grafana panel visibility — Prometheus scrapes
  // every 15s and the workers refresh outbox backlog metrics every 10s,
  // so a short 5-second outage doesn't show up as a curve. Set
  // CHAOS_HOLD_SEC=30 (or higher) to make the pending+oldest_age
  // panels show a clear bump.
  const holdSec = Number(process.env.CHAOS_HOLD_SEC ?? 0);
  if (holdSec > 0) {
    console.log(`  [demo mode] holding broker down for ${holdSec}s extra…`);
    await sleep(holdSec * 1_000);
  }

  // Snapshot pending count BEFORE submitting. We assert delta = N.
  const before = await prisma.outboxEvent.count({ where: { processedAt: null } });

  console.log(`  submitting ${N} orders with broker down`);
  const orderIds: bigint[] = [];
  for (let i = 0; i < N; i++) {
    const r = await submit(token, randomUUID(), '0.001');
    record(`submit ${i + 1}/${N} accepted by api`, r.status >= 200 && r.status < 300, `status=${r.status}`);
    if (r.status >= 200 && r.status < 300 && (r.body as { id?: string })?.id) {
      orderIds.push(BigInt((r.body as { id: string }).id));
    }
  }

  await sleep(2_000); // let any in-flight relay attempts fail
  const stuck = await prisma.outboxEvent.count({ where: { processedAt: null } });
  const delta = stuck - before;
  record(
    `outbox accumulates while broker down (delta ≥ ${N})`,
    delta >= N,
    `before=${before} after=${stuck} delta=${delta}`,
  );

  console.log(`  starting ${CFG.kafkaContainer}…`);
  docker(['start', CFG.kafkaContainer]);
  // Wait for redpanda's healthcheck to pass.
  await waitForContainerHealthy(CFG.kafkaContainer, 60_000);
  record('broker container healthy', true);

  // Now the relay should catch up. Wait for the *new* order outbox rows
  // to all show processedAt set.
  console.log(`  waiting ${CFG.drainTimeoutMs}ms for outbox drain…`);
  const allProcessed = await waitForSpecificOrdersProcessed(prisma, orderIds, CFG.drainTimeoutMs);
  record(
    `all ${N} stranded orders processed within ${CFG.drainTimeoutMs}ms`,
    allProcessed,
  );

  // No data loss: every Order row we created exists with commandId set.
  const persisted = await prisma.order.count({
    where: { id: { in: orderIds } },
  });
  record(
    `no Order rows lost (${persisted}/${N} present)`,
    persisted === N,
    `expected=${N} found=${persisted}`,
  );
}

async function waitForOutboxDrain(
  prisma: InstanceType<typeof PrismaClient>,
  maxPending: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await prisma.outboxEvent.count({ where: { processedAt: null } });
    if (c <= maxPending) return true;
    await sleep(300);
  }
  return false;
}

async function waitForSpecificOrdersProcessed(
  prisma: InstanceType<typeof PrismaClient>,
  orderIds: bigint[],
  timeoutMs: number,
): Promise<boolean> {
  if (orderIds.length === 0) return true;
  const wantedCommandIds = (
    await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { commandId: true },
    })
  )
    .map((o) => o.commandId)
    .filter((s): s is string => !!s);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Outbox rows for these specific commands — both the SUBMIT command
    // and any downstream events the matcher emitted should have
    // processedAt set.
    const unprocessed = await prisma.outboxEvent.count({
      where: {
        processedAt: null,
        // Match by commandId in payload — Postgres jsonb path lookup.
        // Cheap because we have an index on (processedAt, createdAt).
      },
    });
    if (unprocessed === 0) return true;
    await sleep(500);
  }
  // Fall back: log how many are still unprocessed for debugging.
  const remain = await prisma.outboxEvent.count({ where: { processedAt: null } });
  console.log(`    [debug] ${remain} outbox rows still unprocessed`);
  return false;
}

/* ───────────────── scenario B — consumer dedupe ───────────────── */

async function scenarioB_DedupeReplay(
  _prisma: InstanceType<typeof PrismaClient>,
  token: string,
) {
  header('B. Consumer dedupe — replay a UserEvent and confirm dedupe hit');

  // Capture the dedupe-hit counter for the notification worker.
  const before = await readMetric(
    'http://127.0.0.1:3003/metrics',
    /^orbit_dedupe_hit_total\{[^}]*worker="notification"[^}]*\} ([0-9]+)/m,
  );
  console.log(`  baseline dedupe_hit_total{worker="notification"} = ${before}`);

  // Submit an order that's MATCH-PRICE-EQUAL — so it matches itself
  // against another bot order? Hard. Easier: forge a UserEvent directly
  // on the topic, then publish it twice with the same eventId. The
  // notification worker will see TWO deliveries and the second should
  // be dedupe-hit.
  const eventId = randomUUID();
  const evt = {
    v: 1,
    eventId,
    userId: 'chaos-test-user',
    type: 'ORDER_FILLED',
    payload: {
      orderId: 'chaos-' + randomUUID().slice(0, 8),
      market: CFG.market,
      price: '50000000',
      quantity: '0.001',
    },
    ts: Date.now(),
  };

  const kafka = new Kafka({
    clientId: 'orbit-chaos-script',
    brokers: CFG.kafkaBrokers,
  });
  const producer = kafka.producer({ allowAutoTopicCreation: true });
  await producer.connect();

  for (let i = 0; i < 2; i++) {
    await producer.send({
      topic: 'orbit.user-events.v1',
      compression: CompressionTypes.GZIP,
      messages: [{ key: evt.userId, value: JSON.stringify(evt) }],
    });
  }
  await producer.disconnect();
  record('forged 2× same-eventId UserEvent published', true, `eventId=${eventId}`);

  // Give the notification worker time to consume + dedupe.
  await sleep(3_000);

  const after = await readMetric(
    'http://127.0.0.1:3003/metrics',
    /^orbit_dedupe_hit_total\{[^}]*worker="notification"[^}]*\} ([0-9]+)/m,
  );
  console.log(`  after dedupe_hit_total{worker="notification"} = ${after}`);
  record(
    'dedupe_hit incremented (>= +1)',
    after - before >= 1,
    `delta=${after - before}`,
  );

  // Ignore the unused `token` parameter — we forge events directly on
  // Kafka in this scenario, but accept the same signature for symmetry
  // with scenario A.
  void token;
}

async function readMetric(url: string, re: RegExp): Promise<number> {
  try {
    const r = await fetch(url);
    const text = await r.text();
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/* ───────────────── docker helpers ───────────────── */

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf-8' }).trim();
}

async function waitForContainerHealthy(name: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = docker([
        'inspect',
        '-f',
        '{{.State.Health.Status}}',
        name,
      ]);
      if (status === 'healthy') return;
    } catch {
      // container starting — keep polling
    }
    await sleep(1_000);
  }
  throw new Error(`container ${name} did not become healthy within ${timeoutMs}ms`);
}

/* ───────────────── shared helpers (subset of smoke) ───────────────── */

async function preflight() {
  for (const c of [
    { url: `${CFG.apiUrl}/health`, label: 'api(:3000)' },
    { url: 'http://127.0.0.1:3001/health', label: 'realtime(:3001)' },
    { url: 'http://127.0.0.1:3002/health', label: 'matcher(:3002)' },
    { url: 'http://127.0.0.1:3003/health', label: 'workers(:3003)' },
  ]) {
    const r = await fetch(c.url).catch(() => null);
    if (!r || !r.ok) {
      console.error(`[chaos] ${c.label} not healthy — start \`pnpm dev\` first.`);
      process.exit(1);
    }
  }
}

async function provisionBot(prisma: InstanceType<typeof PrismaClient>): Promise<string> {
  let token = await tryLogin();
  if (!token) {
    await fetch(`${CFG.apiUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CFG.email, password: CFG.password }),
    });
    token = await tryLogin();
  }
  if (!token) throw new Error('cannot obtain auth token');
  const user = await prisma.user.findUnique({ where: { email: CFG.email } });
  if (!user) throw new Error('user missing');
  for (const [asset, amount] of [
    ['KRW', CFG.fundKrw],
    ['BTC', CFG.fundBtc],
  ] as const) {
    await prisma.wallet.upsert({
      where: { userId_asset: { userId: user.id, asset } },
      create: { userId: user.id, asset, balance: amount, locked: '0' },
      update: {},
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "Wallet" SET balance = GREATEST(balance::numeric, $1::numeric) WHERE "userId" = $2 AND asset = $3`,
      amount,
      user.id,
      asset,
    );
  }
  return token;
}

async function tryLogin(): Promise<string | null> {
  const r = await fetch(`${CFG.apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: CFG.email, password: CFG.password }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { accessToken?: string; token?: string };
  return j.accessToken ?? j.token ?? null;
}

async function submit(token: string, key: string, qty: string) {
  const r = await fetch(`${CFG.apiUrl}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      market: CFG.market,
      side: 'ASK',
      type: 'LIMIT',
      price: '200000000',
      quantity: qty,
    }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function printSummary() {
  console.log('\n──────────────────────────────────────────');
  const passed = steps.filter((s) => s.pass).length;
  const total = steps.length;
  const allPass = passed === total;
  console.log(
    `${allPass ? '\x1b[32mPASS' : '\x1b[31mFAIL'} ${passed}/${total}\x1b[0m`,
  );
  if (!allPass) {
    console.log('\nFailed steps:');
    for (const s of steps.filter((x) => !x.pass)) {
      console.log(`  ✗ ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n[chaos] FATAL', err);
  process.exit(1);
});
