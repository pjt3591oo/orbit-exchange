-- Replay lineage tracking for DlqEvent — distinguishes "replay 성공"
-- from "replay 후 재실패" without needing an extra resolution enum value.
-- See apps/api/src/admin/dlq for the read path.

ALTER TABLE "DlqEvent" ADD COLUMN "replayedFromId" BIGINT;
CREATE INDEX "DlqEvent_replayedFromId_idx" ON "DlqEvent"("replayedFromId");
