-- Migration 002 — reversals
--
-- Slice 6 adds REFUND / ROLLBACK operations. They need:
--  * A new status `PENDING_REFERENCE` so reversals delivered before
--    their original BET/WIN/REFUND can wait without consuming the
--    unique idempotency key.
--  * A unique partial index that prevents the same (reference, type)
--    from being reversed twice — see spec scenario "Reversão
--    duplicada concorrente".
--
-- Anonymous CHECK constraints in PostgreSQL are named
-- "<table>_<column>_check". Drop + add is the canonical way to evolve
-- them.

ALTER TABLE wager_transactions
  DROP CONSTRAINT wager_transactions_status_check;

ALTER TABLE wager_transactions
  ADD CONSTRAINT ck_wager_status_extended
  CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'));

CREATE UNIQUE INDEX uq_wager_reversal_reference_type
  ON wager_transactions (reference, type)
  WHERE type IN ('REFUND','ROLLBACK');

-- The terminal-state invariants on PROCESSED/REJECTED/FAILED are
-- untouched: PENDING_REFERENCE is non-terminal, the existing CHECKs
-- only fire on the three terminal states, so they remain valid.
-- (No drop+recreate needed; the migration 001 expressions already
-- accommodate the new status.)