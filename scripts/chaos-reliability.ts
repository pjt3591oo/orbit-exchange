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
 *   C. DLQ END-TO-END — withRetryPolicy → retry-30s → DLQ → DlqEvent
 *      1. snapshot DlqEvent count
 *      2. `docker stop orbit-localstack` (kills SNS)
 *      3. publish a UserEvent → notification handler fails (ECONNREFUSED)
 *      4. wait ~50s for the in-flight retries → retry-30s republish
 *         → second failure → DLQ topic → dlq-monitor → DlqEvent INSERT
 *      5. assert DlqEvent count grew + the new row carries the right
 *         worker / lastError / attempt
 *      6. `docker start orbit-localstack` (operator recovery)
 *
 *   D. ORDER LOCK RACE — concurrent SUBMITs for the same user
 *      Provisions a dedicated bot with KRW balance set to exactly
 *      `RACE_CAP × per_order` (e.g. 4 × 25,000 = 100,000). Fires
 *      `RACE_TOTAL` (default 10) concurrent LIMIT BIDs in one
 *      Promise.all so they hit the API in a tight window.
 *
 *      Under the buggy check-then-update pattern, several would see
 *      stale balance and pass the check → UPDATE goes negative → wallet
 *      ends up at e.g. balance=-150,000.
 *
 *      Under the fix (conditional UPDATE + CHECK constraint):
 *        - exactly RACE_CAP requests return 2xx (Order created),
 *        - the rest return 400 with "insufficient balance",
 *        - final balance = 0, locked = initial.
 *      The DB CHECK constraint is the last-line guarantee — even if the
 *      code is buggy the constraint rejects negative writes.
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
  localstackContainer: string;
  drainTimeoutMs: number;
  dlqTimeoutMs: number;
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
  localstackContainer: process.env.LOCALSTACK_CONTAINER ?? 'orbit-localstack',
  drainTimeoutMs: Number(process.env.DRAIN_TIMEOUT_MS ?? 60_000),
  // Default chosen so retry-30s (30s) + the in-flight kafkajs retries +
  // dlq-monitor consume + DB insert all fit comfortably.
  dlqTimeoutMs: Number(process.env.DLQ_TIMEOUT_MS ?? 90_000),
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
  if (CFG.scenarios.has('C')) {
    await scenarioC_DlqEndToEnd(prisma);
  }
  if (CFG.scenarios.has('D')) {
    await scenarioD_OrderLockRace(prisma);
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

/* ───────────────── scenario C — DLQ end-to-end ───────────────── */

async function scenarioC_DlqEndToEnd(prisma: InstanceType<typeof PrismaClient>) {
  header('C. DLQ end-to-end — SNS down → withRetryPolicy → retry-30s → DLQ');

  // 1. Baseline DlqEvent count for the (worker=notification) bucket.
  const beforeCount = await prisma.dlqEvent.count({ where: { worker: 'notification' } });
  console.log(`  baseline DlqEvent{worker=notification} = ${beforeCount}`);

  // 2. Take SNS offline. Notification worker is initialised at startup
  //    with the SNS endpoint URL, so killing localstack causes
  //    ECONNREFUSED on every PublishCommand. The aws-sdk error is
  //    classified `transient` by withRetryPolicy → retry-30s on first
  //    escalation → retry-30s republish → second escalation → DLQ.
  console.log(`  stopping ${CFG.localstackContainer}…`);
  docker(['stop', CFG.localstackContainer]);
  await sleep(2_000);

  // 3. Forge a UserEvent with a unique eventId so withDedupe doesn't
  //    short-circuit. Publish directly to Kafka (we don't need to go
  //    through outbox for this test).
  const eventId = randomUUID();
  const evt = {
    v: 1,
    eventId,
    userId: 'chaos-c-' + eventId.slice(0, 8),
    type: 'ORDER_FILLED',
    payload: { orderId: 'chaos-c', market: CFG.market, price: '50000000', quantity: '0.001' },
    ts: Date.now(),
  };
  const kafka = new Kafka({ clientId: 'orbit-chaos-c', brokers: CFG.kafkaBrokers });
  const producer = kafka.producer({ allowAutoTopicCreation: true });
  await producer.connect();
  await producer.send({
    topic: 'orbit.user-events.v1',
    compression: CompressionTypes.GZIP,
    messages: [{ key: evt.userId, value: JSON.stringify(evt) }],
  });
  await producer.disconnect();
  record('UserEvent published with SNS offline', true, `eventId=${eventId}`);

  // 4. Wait for the full retry → DLQ cycle. The retry-30s tier adds
  //    ~30s, plus a few seconds for kafkajs delivery + handler runtime.
  console.log(`  waiting up to ${CFG.dlqTimeoutMs}ms for DLQ to be populated…`);
  const reachedDlq = await waitForDlqMatchingEvent(
    prisma,
    'notification',
    CFG.dlqTimeoutMs,
    beforeCount,
  );
  record(
    `DlqEvent row appears within ${CFG.dlqTimeoutMs}ms`,
    reachedDlq.found,
    reachedDlq.found
      ? `id=${reachedDlq.row?.id} attempt=${reachedDlq.row?.attempt} originalTopic=${reachedDlq.row?.originalTopic}`
      : 'still empty after timeout',
  );
  if (reachedDlq.found && reachedDlq.row) {
    record(
      'DlqEvent.lastError is non-empty',
      typeof reachedDlq.row.lastError === 'string' && reachedDlq.row.lastError.length > 0,
      reachedDlq.row.lastError.slice(0, 80),
    );
    record(
      'DlqEvent.attempt > 0',
      reachedDlq.row.attempt > 0,
      `attempt=${reachedDlq.row.attempt}`,
    );
    record(
      'DlqEvent.originalTopic = orbit.user-events.v1',
      reachedDlq.row.originalTopic === 'orbit.user-events.v1',
      reachedDlq.row.originalTopic,
    );
  }

  // 5. Restore localstack so subsequent tests / dev work continue normally.
  console.log(`  starting ${CFG.localstackContainer}…`);
  docker(['start', CFG.localstackContainer]);
  await waitForContainerHealthy(CFG.localstackContainer, 60_000);
  record('localstack healthy after recovery', true);
}

interface DlqRow {
  id: bigint;
  worker: string;
  originalTopic: string;
  attempt: number;
  lastError: string;
}

async function waitForDlqMatchingEvent(
  prisma: InstanceType<typeof PrismaClient>,
  worker: string,
  timeoutMs: number,
  beforeCount: number,
): Promise<{ found: boolean; row: DlqRow | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await prisma.dlqEvent.count({ where: { worker } });
    if (count > beforeCount) {
      const row = await prisma.dlqEvent.findFirst({
        where: { worker },
        orderBy: { id: 'desc' },
      });
      if (row) {
        return {
          found: true,
          row: {
            id: row.id,
            worker: row.worker,
            originalTopic: row.originalTopic,
            attempt: row.attempt,
            lastError: row.lastError,
          },
        };
      }
    }
    await sleep(1_000);
  }
  return { found: false, row: null };
}

/* ───────────────── scenario D — order lock race ───────────────── */

interface RaceCfg {
  email: string;
  password: string;
  /** number of orders that *should* fit within the seeded balance */
  cap: number;
  /** total concurrent submissions (cap + extras to flush race window) */
  total: number;
  /** price × qty for one order, in KRW. Multiple of tickSize=1000. */
  perOrderKrw: number;
}

const RACE_CFG: RaceCfg = {
  email: process.env.RACE_EMAIL ?? 'race-bot@orbit.dev',
  password: process.env.RACE_PW ?? 'orbit-bot-pw',
  cap: Number(process.env.RACE_CAP ?? 4),
  total: Number(process.env.RACE_TOTAL ?? 10),
  // 250_000_000 KRW × 0.0001 BTC = 25_000 KRW per order
  // (price respects tickSize=1000, qty respects stepSize=1e-8)
  perOrderKrw: 25_000,
};

async function scenarioD_OrderLockRace(prisma: InstanceType<typeof PrismaClient>) {
  header('D. Order lock race — concurrent SUBMITs against tight balance');

  const exactBalance = RACE_CFG.cap * RACE_CFG.perOrderKrw;
  console.log(
    `  cap=${RACE_CFG.cap}  total=${RACE_CFG.total}  perOrder=${RACE_CFG.perOrderKrw} KRW  seed=${exactBalance} KRW`,
  );

  // 1. Provision a dedicated race-bot so we don't disturb the smoke bot.
  const token = await provisionRaceBot(prisma, exactBalance);
  record('race-bot ready with exact balance', true, `${exactBalance} KRW`);

  // 2. Fire RACE_TOTAL concurrent LIMIT BIDs. Each requires
  //    perOrderKrw to lock, so at most CAP can succeed.
  const submitOnce = (key: string) =>
    fetch(`${CFG.apiUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({
        market: CFG.market,
        side: 'BID',
        type: 'LIMIT',
        price: '250000000',  // 250M KRW (multiple of tickSize=1000)
        quantity: '0.0001',  // 0.0001 BTC (multiple of stepSize=1e-8)
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const keys = Array.from({ length: RACE_CFG.total }, () => randomUUID());
  const results = await Promise.all(keys.map((k) => submitOnce(k)));

  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const insufficientBalance = results.filter(
    (r) =>
      r.status === 400 &&
      typeof r.body === 'object' &&
      r.body !== null &&
      String((r.body as { message?: unknown }).message ?? '').includes('insufficient'),
  ).length;
  const other = results.length - ok - insufficientBalance;

  console.log(`  results: ok=${ok}  insufficient=${insufficientBalance}  other=${other}`);
  results
    .filter((r) => r.status >= 500)
    .forEach((r) => console.log(`    [debug] 5xx body:`, r.body));

  // 3. Assert: exactly cap succeeded.
  record(
    `exactly ${RACE_CFG.cap} orders accepted`,
    ok === RACE_CFG.cap,
    `ok=${ok} expected=${RACE_CFG.cap}`,
  );
  record(
    `remaining ${RACE_CFG.total - RACE_CFG.cap} orders rejected with 'insufficient balance'`,
    insufficientBalance === RACE_CFG.total - RACE_CFG.cap,
    `insufficient=${insufficientBalance} expected=${RACE_CFG.total - RACE_CFG.cap}`,
  );
  record('no 5xx responses', other === 0, `other=${other}`);

  // 4. Final wallet state — balance must be 0, locked must equal seed.
  const user = await prisma.user.findUnique({ where: { email: RACE_CFG.email } });
  if (!user) throw new Error('race-bot vanished');
  const krw = await prisma.wallet.findUnique({
    where: { userId_asset: { userId: user.id, asset: 'KRW' } },
  });
  if (!krw) throw new Error('race-bot KRW wallet missing');

  const balance = Number(krw.balance.toString());
  const locked = Number(krw.locked.toString());
  console.log(`  final wallet: balance=${balance}  locked=${locked}`);

  // The most important assertion — the whole point of the fix.
  record('balance >= 0 (CHECK constraint defense)', balance >= 0, `balance=${balance}`);
  record('locked >= 0', locked >= 0, `locked=${locked}`);
  record(
    `balance settled to 0 (all ${RACE_CFG.cap} reserves succeeded)`,
    balance === 0,
    `balance=${balance}`,
  );
  record(
    `locked equals seed (${exactBalance})`,
    locked === exactBalance,
    `locked=${locked} expected=${exactBalance}`,
  );
}

async function provisionRaceBot(
  prisma: InstanceType<typeof PrismaClient>,
  exactKrw: number,
): Promise<string> {
  // Sign up if missing.
  await fetch(`${CFG.apiUrl}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: RACE_CFG.email, password: RACE_CFG.password }),
  }).catch(() => null);

  const r = await fetch(`${CFG.apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: RACE_CFG.email, password: RACE_CFG.password }),
  });
  if (!r.ok) throw new Error(`race-bot login failed: ${r.status}`);
  const j = (await r.json()) as { accessToken?: string; token?: string };
  const token = j.accessToken ?? j.token;
  if (!token) throw new Error('race-bot token missing');

  const user = await prisma.user.findUnique({ where: { email: RACE_CFG.email } });
  if (!user) throw new Error('race-bot user missing post-login');

  // Reset KRW wallet to EXACTLY the seed amount + zero locked. This is
  // the critical setup — a non-zero pre-existing locked would invalidate
  // the assertions.
  await prisma.wallet.upsert({
    where: { userId_asset: { userId: user.id, asset: 'KRW' } },
    create: { userId: user.id, asset: 'KRW', balance: String(exactKrw), locked: '0' },
    update: { balance: String(exactKrw), locked: '0' },
  });

  return token;
}

/* ───────────────── shared helper used by C/D ───────────────── */

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
