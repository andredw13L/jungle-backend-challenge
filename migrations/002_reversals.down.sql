-- Migration 002 down — reverse reversals
DROP INDEX IF EXISTS uq_wager_reversal_reference_type;

ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_status_extended;
ALTER TABLE wager_transactions
  ADD CONSTRAINT wager_transactions_status_check
  CHECK (status IN ('PENDING','PROCESSED','REJECTED','FAILED'));