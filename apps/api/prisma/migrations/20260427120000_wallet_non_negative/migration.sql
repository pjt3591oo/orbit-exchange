-- ADR-FOLLOWUP: Wallet balance / locked must stay >= 0.
--
-- Defense in depth for the check-then-update race:
--   1. Application uses conditional UPDATE in lockReservation (the
--      primary fix — atomic check + decrement).
--   2. This CHECK is the safety net. Any code path that forgets to use
--      the conditional UPDATE — settler corner cases, future admin
--      adjustments, schema migrations — will be rejected by the DB
--      before producing a negative balance.
--
-- Pre-condition: no current rows violate (verified via SELECT before
-- this migration). If a future migration runs against tainted data,
-- swap to `... NOT VALID` then `VALIDATE CONSTRAINT` after cleanup.

ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_balance_non_negative" CHECK (balance >= 0);

ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_locked_non_negative" CHECK (locked >= 0);
