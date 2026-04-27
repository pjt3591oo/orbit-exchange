-- ADR-0004 — DlqEvent ledger for admin replay UI.
-- See docs/failure-scenarios/adr/0004-dlq-topology.md.

CREATE TABLE "DlqEvent" (
    "id" BIGSERIAL NOT NULL,
    "originalTopic" TEXT NOT NULL,
    "originalPartition" INTEGER NOT NULL,
    "originalOffset" TEXT NOT NULL,
    "payload" BYTEA NOT NULL,
    "headers" JSONB NOT NULL,
    "worker" TEXT NOT NULL,
    "lastError" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolvedBy" TEXT,
    CONSTRAINT "DlqEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DlqEvent_resolvedAt_enqueuedAt_idx" ON "DlqEvent"("resolvedAt", "enqueuedAt");
CREATE INDEX "DlqEvent_originalTopic_enqueuedAt_idx" ON "DlqEvent"("originalTopic", "enqueuedAt");
CREATE INDEX "DlqEvent_worker_enqueuedAt_idx" ON "DlqEvent"("worker", "enqueuedAt");
