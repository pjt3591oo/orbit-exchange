-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BID', 'ASK');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('LIMIT', 'MARKET');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CandleInterval" AS ENUM ('M1', 'M5', 'M15', 'H1', 'H4', 'D1');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "balance" DECIMAL(28,12) NOT NULL DEFAULT 0,
    "locked" DECIMAL(28,12) NOT NULL DEFAULT 0,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "symbol" TEXT NOT NULL,
    "baseAsset" TEXT NOT NULL,
    "quoteAsset" TEXT NOT NULL,
    "tickSize" DECIMAL(28,12) NOT NULL,
    "stepSize" DECIMAL(28,12) NOT NULL,
    "minNotional" DECIMAL(28,12) NOT NULL,
    "takerFeeBp" INTEGER NOT NULL DEFAULT 20,
    "makerFeeBp" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "price" DECIMAL(28,12),
    "quantity" DECIMAL(28,12) NOT NULL,
    "leaveQty" DECIMAL(28,12) NOT NULL,
    "filledQty" DECIMAL(28,12) NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" BIGSERIAL NOT NULL,
    "sequence" BIGINT NOT NULL,
    "market" TEXT NOT NULL,
    "price" DECIMAL(28,12) NOT NULL,
    "quantity" DECIMAL(28,12) NOT NULL,
    "makerOrderId" BIGINT NOT NULL,
    "takerOrderId" BIGINT NOT NULL,
    "makerSide" "OrderSide" NOT NULL,
    "takerSide" "OrderSide" NOT NULL,
    "makerUserId" TEXT NOT NULL,
    "takerUserId" TEXT NOT NULL,
    "makerFee" DECIMAL(28,12) NOT NULL,
    "takerFee" DECIMAL(28,12) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" BIGSERIAL NOT NULL,
    "market" TEXT NOT NULL,
    "interval" "CandleInterval" NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(28,12) NOT NULL,
    "high" DECIMAL(28,12) NOT NULL,
    "low" DECIMAL(28,12) NOT NULL,
    "close" DECIMAL(28,12) NOT NULL,
    "volume" DECIMAL(28,12) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_asset_key" ON "Wallet"("userId", "asset");

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_market_status_price_idx" ON "Order"("market", "status", "price");

-- CreateIndex
CREATE INDEX "Trade_market_createdAt_idx" ON "Trade"("market", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_makerOrderId_idx" ON "Trade"("makerOrderId");

-- CreateIndex
CREATE INDEX "Trade_takerOrderId_idx" ON "Trade"("takerOrderId");

-- CreateIndex
CREATE INDEX "Candle_market_interval_openTime_idx" ON "Candle"("market", "interval", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_market_interval_openTime_key" ON "Candle"("market", "interval", "openTime");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_asset_fkey" FOREIGN KEY ("asset") REFERENCES "Asset"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_market_fkey" FOREIGN KEY ("market") REFERENCES "Market"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_market_fkey" FOREIGN KEY ("market") REFERENCES "Market"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_market_fkey" FOREIGN KEY ("market") REFERENCES "Market"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;
