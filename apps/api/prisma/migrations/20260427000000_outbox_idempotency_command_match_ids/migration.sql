-- ADR-0002 (outbox) + ADR-0003 (idempotency)
-- See docs/failure-scenarios/adr/ for design rationale.

-- 1. Order.commandId — UUID v4 minted by API at submission, consumed by
--    matcher to detect duplicate command delivery. Nullable so existing rows
--    remain valid. Postgres allows multiple NULLs in a UNIQUE constraint.
ALTER TABLE "Order" ADD COLUMN "commandId" TEXT;
CREATE UNIQUE INDEX "Order_commandId_key" ON "Order"("commandId");

-- 2. Trade.matchId — `<commandId>#<idx>` produced by settler. Defense-in-depth
--    against double-settlement. Nullable for existing rows.
ALTER TABLE "Trade" ADD COLUMN "matchId" TEXT;
CREATE UNIQUE INDEX "Trade_matchId_key" ON "Trade"("matchId");

-- 3. OutboxEvent — transactional outbox table. Producers INSERT inside the
--    same $transaction that mutates Order/Trade/Wallet. The outbox-relay
--    worker polls processedAt IS NULL rows in createdAt order.
CREATE TABLE "OutboxEvent" (
    "id" BIGSERIAL NOT NULL,
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutboxEvent_processedAt_createdAt_idx" ON "OutboxEvent"("processedAt", "createdAt");
CREATE INDEX "OutboxEvent_topic_createdAt_idx" ON "OutboxEvent"("topic", "createdAt");

-- 4. IdempotencyKey — HTTP-side request idempotency cache.
CREATE TABLE "IdempotencyKey" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdempotencyKey_userId_key_method_path_key" ON "IdempotencyKey"("userId", "key", "method", "path");
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");
