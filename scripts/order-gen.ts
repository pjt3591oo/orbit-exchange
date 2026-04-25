/* eslint-disable no-console */
/**
 * scripts/order-gen.ts — load-testing order generator.
 *
 * Provisions N dedicated bot users (signup or login + fund wallets), then
 * fires LIMIT/MARKET orders against `POST /api/v1/orders` at a target rate
 * for a configurable duration. Open-loop scheduler (fire on a fixed cadence
 * regardless of response time) with an in-flight cap so a slow API does not
 * blow up memory.
 *
 * Run:
 *   pnpm orders:gen                                     # defaults
 *   RATE=100 DURATION=120 BOTS=20 pnpm orders:gen       # heavy load
 *   MARKET=ETH-KRW BASE_PRICE=3000000 pnpm orders:gen
 *   DURATION=0 pnpm orders:gen                          # run until SIGINT
 *
 * Tunables (env vars):
 *   API_URL           default http://localhost:3000
 *   MARKET            default BTC-KRW
 *   BOTS              default 10
 *   RATE              orders/sec        default 20
 *   DURATION          seconds (0 = forever)   default 60
 *   MAX_INFLIGHT      cap before dropping ticks   default 200
 *   BASE_PRICE        per market, see defaultBasePrice()
 *   SPREAD_BP         half-spread in basis points   default 50  (= 0.50%)
 *   MARKET_RATIO      fraction sent as MARKET      default 0.05
 *   QTY_MIN/QTY_MAX   per-order qty range          default 0.001..0.02
 *   FUND_KRW/FUND_BTC/FUND_ETH/FUND_USDT  wallet top-up
 *   PASSWORD          bot user password           default orbit-bot-pw
 *   BOT_PREFIX        email prefix                default loadbot
 *   VERBOSE=1         log every error response
 *
 * Resolution trick: this script is at repo root, but its dependencies
 * (@prisma/client) live in apps/api. We use createRequire anchored at
 * apps/api/package.json so we don't have to install anything at root.
 * tsx is borrowed the same way via the package.json launcher
 * (`pnpm --filter @orbit/api exec tsx ...`).
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

/* ───────────────── workspace / dep discovery ───────────────── */

const repoRoot = (() => {
  let cur = process.cwd();
  while (cur !== '/') {
    if (fs.existsSync(path.join(cur, 'pnpm-workspace.yaml'))) return cur;
    cur = path.dirname(cur);
  }
  throw new Error(`run from inside the orbit repo (cwd=${process.cwd()})`);
})();

const apiPkg = path.join(repoRoot, 'apps/api/package.json');
if (!fs.existsSync(apiPkg)) {
  throw new Error(`apps/api/package.json not found at ${apiPkg}`);
}
const apiRequire = createRequire(apiPkg);
const { PrismaClient, Prisma } =
  apiRequire('@prisma/client') as typeof import('@prisma/client');

function loadDotEnv(p: string) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
// Pick up DATABASE_URL etc. from apps/api/.env if not already set.
loadDotEnv(path.join(repoRoot, 'apps/api/.env'));

/* ───────────────── config ───────────────── */

function defaultBasePrice(mkt: string): number {
  if (mkt === 'BTC-KRW') return 50_000_000;
  if (mkt === 'ETH-KRW') return 3_000_000;
  if (mkt === 'BTC-USDT') return 50_000;
  return 100;
}

const cfg = {
  apiUrl: process.env.API_URL ?? 'http://localhost:3000',
  market: process.env.MARKET ?? 'BTC-KRW',
  bots: Math.max(1, Number(process.env.BOTS ?? 10)),
  rate: Math.max(1, Number(process.env.RATE ?? 20)),
  duration: Number(process.env.DURATION ?? 60), // 0 = forever
  maxInflight: Number(process.env.MAX_INFLIGHT ?? 200),
  basePrice: Number(process.env.BASE_PRICE ?? defaultBasePrice(process.env.MARKET ?? 'BTC-KRW')),
  spreadBp: Number(process.env.SPREAD_BP ?? 50),
  marketRatio: Number(process.env.MARKET_RATIO ?? 0.05),
  qtyMin: Number(process.env.QTY_MIN ?? 0.001),
  qtyMax: Number(process.env.QTY_MAX ?? 0.02),
  fundKrw: process.env.FUND_KRW ?? '100000000000000', // 100조
  fundBtc: process.env.FUND_BTC ?? '1000000',
  fundEth: process.env.FUND_ETH ?? '1000000',
  fundUsdt: process.env.FUND_USDT ?? '10000000000',
  password: process.env.PASSWORD ?? 'orbit-bot-pw',
  botPrefix: process.env.BOT_PREFIX ?? 'loadbot',
  verbose: !!process.env.VERBOSE,
};

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set (looked at env + apps/api/.env)');
  process.exit(1);
}

/* ───────────────── market spec ───────────────── */

type MarketSpec = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  stepSize: number;
  minNotional: number;
};

async function fetchMarketSpec(): Promise<MarketSpec> {
  const r = await fetch(`${cfg.apiUrl}/api/v1/markets`);
  if (!r.ok) throw new Error(`GET /api/v1/markets ${r.status} ${await r.text()}`);
  const list = (await r.json()) as Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    tickSize: string;
    stepSize: string;
    minNotional: string;
  }>;
  const m = list.find((x) => x.symbol === cfg.market);
  if (!m) throw new Error(`market ${cfg.market} not enabled (have: ${list.map((x) => x.symbol).join(', ')})`);
  return {
    symbol: m.symbol,
    baseAsset: m.baseAsset,
    quoteAsset: m.quoteAsset,
    tickSize: Number(m.tickSize),
    stepSize: Number(m.stepSize),
    minNotional: Number(m.minNotional),
  };
}

/* ───────────────── bot provisioning ───────────────── */

type Bot = { id: number; email: string; userId: string; token: string };

async function signupOrLogin(
  email: string,
  password: string,
): Promise<{ userId: string; token: string }> {
  // Try signup. If the email already exists the API returns 409 → fall back to login.
  let r = await fetch(`${cfg.apiUrl}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (r.status === 409) {
    r = await fetch(`${cfg.apiUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }
  if (!r.ok) {
    throw new Error(`auth ${email}: ${r.status} ${await r.text()}`);
  }
  const j = (await r.json()) as { accessToken: string; userId: string };
  return { userId: j.userId, token: j.accessToken };
}

async function fundBot(prisma: InstanceType<typeof PrismaClient>, userId: string) {
  const seed: Array<[string, string]> = [
    ['KRW', cfg.fundKrw],
    ['BTC', cfg.fundBtc],
    ['ETH', cfg.fundEth],
    ['USDT', cfg.fundUsdt],
  ];
  for (const [asset, amount] of seed) {
    await prisma.wallet.upsert({
      where: { userId_asset: { userId, asset } },
      // Top up balance only — leaving `locked` alone preserves any active orders.
      update: { balance: new Prisma.Decimal(amount) },
      create: { userId, asset, balance: new Prisma.Decimal(amount) },
    });
  }
}

async function provisionBots(prisma: InstanceType<typeof PrismaClient>): Promise<Bot[]> {
  console.log(`[provision] preparing ${cfg.bots} bot user(s)…`);
  const bots: Bot[] = [];
  for (let i = 1; i <= cfg.bots; i++) {
    const email = `${cfg.botPrefix}-${i}@orbit.dev`;
    const { userId, token } = await signupOrLogin(email, cfg.password);
    await fundBot(prisma, userId);
    bots.push({ id: i, email, userId, token });
  }
  console.log(`[provision] ✓ ${bots.length} bots ready (password=${cfg.password})`);
  return bots;
}

/* ───────────────── order shaping ───────────────── */

function decimalsFromStep(step: number): number {
  if (step >= 1) return 0;
  return Math.max(0, Math.round(-Math.log10(step)));
}
function roundDown(x: number, step: number): number {
  return Math.floor(x / step) * step;
}
function roundQty(qty: number, step: number): string {
  const decimals = decimalsFromStep(step);
  return roundDown(qty, step).toFixed(decimals);
}
function roundPrice(p: number, tick: number): string {
  const decimals = decimalsFromStep(tick);
  return roundDown(p, tick).toFixed(decimals);
}

let mid = cfg.basePrice;
function nextMid(): number {
  // micro random walk so the resting book drifts; clamped to ±50% of base.
  const drift = mid * 0.00005 * (Math.random() * 2 - 1);
  mid = Math.max(cfg.basePrice * 0.5, Math.min(cfg.basePrice * 1.5, mid + drift));
  return mid;
}

type OrderBody =
  | { market: string; side: 'BID' | 'ASK'; type: 'LIMIT'; price: string; quantity: string }
  | { market: string; side: 'BID' | 'ASK'; type: 'MARKET'; quantity: string };

function pickOrder(spec: MarketSpec): OrderBody {
  const side: 'BID' | 'ASK' = Math.random() < 0.5 ? 'BID' : 'ASK';
  const isMarket = Math.random() < cfg.marketRatio;
  const m = nextMid();

  // Quantity uniform in [qtyMin, qtyMax], aligned to stepSize.
  const rawQty = cfg.qtyMin + Math.random() * (cfg.qtyMax - cfg.qtyMin);
  let quantity = roundQty(rawQty, spec.stepSize);
  if (Number(quantity) <= 0) quantity = roundQty(spec.stepSize, spec.stepSize);

  if (isMarket) {
    return { market: spec.symbol, side, type: 'MARKET', quantity };
  }

  // LIMIT: ±spread around mid, with slight side-bias so most orders rest
  // but ~20–30% cross and trade.
  const spread = cfg.spreadBp / 10000;
  const offset = (Math.random() * 2 - 1) * spread;
  const lean = side === 'BID' ? -spread * 0.3 : +spread * 0.3;
  const rawPrice = m * (1 + offset + lean);
  let price = roundPrice(Math.max(spec.tickSize, rawPrice), spec.tickSize);

  // Bump qty if minNotional violated.
  if (Number(price) * Number(quantity) < spec.minNotional) {
    const minQty = (spec.minNotional / Number(price)) * 1.1;
    quantity = roundQty(Math.max(minQty, cfg.qtyMin), spec.stepSize);
    if (Number(price) * Number(quantity) < spec.minNotional) {
      // Last-resort: bump price up by one tick.
      price = roundPrice(Number(price) + spec.tickSize, spec.tickSize);
    }
  }
  return { market: spec.symbol, side, type: 'LIMIT', price, quantity };
}

/* ───────────────── stats ───────────────── */

class Stats {
  sent = 0;
  ok = 0;
  http4xx = 0;
  http5xx = 0;
  errors = 0;
  dropped = 0;
  inflight = 0;
  // ring buffer for latency samples (ms)
  ring = new Float64Array(10000);
  ringIdx = 0;
  ringFilled = 0;

  recordLatency(ms: number) {
    this.ring[this.ringIdx] = ms;
    this.ringIdx = (this.ringIdx + 1) % this.ring.length;
    if (this.ringFilled < this.ring.length) this.ringFilled++;
  }
  percentiles(): { p50: number; p95: number; p99: number } {
    if (this.ringFilled === 0) return { p50: 0, p95: 0, p99: 0 };
    const arr = Array.from(this.ring.slice(0, this.ringFilled)).sort((a, b) => a - b);
    const at = (q: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
  }
}
const stats = new Stats();

/* ───────────────── send ───────────────── */

async function sendOrder(bot: Bot, body: OrderBody) {
  const t0 = performance.now();
  stats.inflight++;
  stats.sent++;
  try {
    const r = await fetch(`${cfg.apiUrl}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bot.token}`,
      },
      body: JSON.stringify(body),
    });
    stats.recordLatency(performance.now() - t0);
    if (r.ok) {
      stats.ok++;
    } else if (r.status >= 500) {
      stats.http5xx++;
      if (cfg.verbose || stats.http5xx <= 3) {
        const txt = await r.text().catch(() => '');
        console.error(`[5xx] ${r.status} ${describe(body)} :: ${txt.slice(0, 200)}`);
      }
    } else {
      stats.http4xx++;
      if (cfg.verbose || stats.http4xx <= 3) {
        const txt = await r.text().catch(() => '');
        console.error(`[4xx] ${r.status} ${describe(body)} :: ${txt.slice(0, 200)}`);
      }
    }
  } catch (e) {
    stats.errors++;
    if (cfg.verbose || stats.errors <= 3) {
      console.error(`[err] ${(e as Error).message}`);
    }
  } finally {
    stats.inflight--;
  }
}

function describe(b: OrderBody): string {
  return b.type === 'LIMIT'
    ? `${b.side} LIMIT ${b.price} × ${b.quantity}`
    : `${b.side} MARKET × ${b.quantity}`;
}

/* ───────────────── main loop ───────────────── */

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, Math.max(0, ms)));

async function main() {
  console.log('[cfg]', {
    api: cfg.apiUrl,
    market: cfg.market,
    bots: cfg.bots,
    rate: `${cfg.rate}/s`,
    duration: cfg.duration === 0 ? '∞ (until SIGINT)' : `${cfg.duration}s`,
    maxInflight: cfg.maxInflight,
    basePrice: cfg.basePrice,
    spreadBp: cfg.spreadBp,
    marketRatio: cfg.marketRatio,
    qtyRange: [cfg.qtyMin, cfg.qtyMax],
  });

  const spec = await fetchMarketSpec();
  console.log(
    `[market] ${spec.symbol} tick=${spec.tickSize} step=${spec.stepSize} minNotional=${spec.minNotional}`,
  );

  const prisma = new PrismaClient();
  let bots: Bot[];
  try {
    bots = await provisionBots(prisma);
  } finally {
    await prisma.$disconnect();
  }

  let stopFlag = false;
  process.on('SIGINT', () => {
    if (stopFlag) {
      console.log('\n[signal] second SIGINT — exiting hard.');
      process.exit(130);
    }
    console.log('\n[signal] SIGINT — draining (Ctrl-C again to abort)…');
    stopFlag = true;
  });

  const periodMs = 1000 / cfg.rate;
  const startedAt = performance.now();
  const endAt =
    cfg.duration > 0 ? startedAt + cfg.duration * 1000 : Number.POSITIVE_INFINITY;
  let nextSlot = startedAt;
  let lastReport = { sent: 0, ok: 0, h4: 0, h5: 0, err: 0, drop: 0 };

  const printer = setInterval(() => {
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    const p = stats.percentiles();
    const dSent = stats.sent - lastReport.sent;
    const dOk = stats.ok - lastReport.ok;
    const d4 = stats.http4xx - lastReport.h4;
    const d5 = stats.http5xx - lastReport.h5;
    const dErr = stats.errors - lastReport.err;
    const dDrop = stats.dropped - lastReport.drop;
    lastReport = {
      sent: stats.sent,
      ok: stats.ok,
      h4: stats.http4xx,
      h5: stats.http5xx,
      err: stats.errors,
      drop: stats.dropped,
    };
    console.log(
      `[t+${elapsed}s] +sent=${dSent} +ok=${dOk} +4xx=${d4} +5xx=${d5} +err=${dErr} +drop=${dDrop} ` +
        `inflight=${stats.inflight} p50=${p.p50.toFixed(0)}ms p95=${p.p95.toFixed(0)}ms p99=${p.p99.toFixed(0)}ms ` +
        `mid=${mid.toFixed(0)}`,
    );
  }, 1000);

  while (!stopFlag && performance.now() < endAt) {
    if (stats.inflight >= cfg.maxInflight) {
      stats.dropped++;
    } else {
      const bot = bots[Math.floor(Math.random() * bots.length)];
      void sendOrder(bot, pickOrder(spec));
    }
    nextSlot += periodMs;
    const slack = nextSlot - performance.now();
    if (slack > 0) {
      await sleep(slack);
    } else if (slack < -250) {
      // we fell more than 250ms behind — resync to "now" so the printer
      // doesn't see a giant burst when we catch up.
      nextSlot = performance.now();
    }
  }

  console.log('[drain] waiting for in-flight requests…');
  const drainStart = performance.now();
  while (stats.inflight > 0 && performance.now() - drainStart < 30_000) {
    await sleep(50);
  }
  clearInterval(printer);

  const total = (performance.now() - startedAt) / 1000;
  const p = stats.percentiles();
  console.log('────── summary ──────');
  console.log(`duration:    ${total.toFixed(1)}s`);
  console.log(`sent:        ${stats.sent}  (${(stats.sent / total).toFixed(1)} /s effective)`);
  console.log(`ok 2xx:      ${stats.ok}`);
  console.log(`http 4xx:    ${stats.http4xx}`);
  console.log(`http 5xx:    ${stats.http5xx}`);
  console.log(`errors:      ${stats.errors}`);
  console.log(`dropped:     ${stats.dropped}  (in-flight cap)`);
  console.log(
    `latency:     p50=${p.p50.toFixed(1)}ms p95=${p.p95.toFixed(1)}ms p99=${p.p99.toFixed(1)}ms`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
