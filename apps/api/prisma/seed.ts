import { PrismaClient, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const assets = [
    { symbol: 'KRW', name: 'Korean Won', decimals: 0 },
    { symbol: 'BTC', name: 'Bitcoin', decimals: 8 },
    { symbol: 'ETH', name: 'Ethereum', decimals: 8 },
    { symbol: 'USDT', name: 'Tether', decimals: 6 },
  ];
  for (const a of assets) {
    await prisma.asset.upsert({ where: { symbol: a.symbol }, update: {}, create: a });
  }

  const markets = [
    {
      symbol: 'BTC-KRW',
      baseAsset: 'BTC',
      quoteAsset: 'KRW',
      tickSize: new Prisma.Decimal('1000'),
      stepSize: new Prisma.Decimal('0.00000001'),
      minNotional: new Prisma.Decimal('5000'),
      takerFeeBp: 20,
      makerFeeBp: 10,
    },
    {
      symbol: 'ETH-KRW',
      baseAsset: 'ETH',
      quoteAsset: 'KRW',
      tickSize: new Prisma.Decimal('100'),
      stepSize: new Prisma.Decimal('0.00000001'),
      minNotional: new Prisma.Decimal('5000'),
      takerFeeBp: 20,
      makerFeeBp: 10,
    },
    {
      symbol: 'BTC-USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: new Prisma.Decimal('0.01'),
      stepSize: new Prisma.Decimal('0.00000001'),
      minNotional: new Prisma.Decimal('1'),
      takerFeeBp: 20,
      makerFeeBp: 10,
    },
  ];
  for (const m of markets) {
    await prisma.market.upsert({ where: { symbol: m.symbol }, update: {}, create: m });
  }

  const demoUsers = [
    { email: 'alice@orbit.dev', seed: { KRW: '100000000', BTC: '2', ETH: '10', USDT: '50000' } },
    { email: 'bob@orbit.dev', seed: { KRW: '100000000', BTC: '2', ETH: '10', USDT: '50000' } },
  ];
  for (const u of demoUsers) {
    const passwordHash = await argon2.hash('orbit1234!');
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { email: u.email, passwordHash },
    });
    for (const [asset, amount] of Object.entries(u.seed)) {
      await prisma.wallet.upsert({
        where: { userId_asset: { userId: user.id, asset } },
        update: {},
        create: { userId: user.id, asset, balance: new Prisma.Decimal(amount) },
      });
    }
  }

  console.log('✓ seed complete');
}

main().finally(() => prisma.$disconnect());
