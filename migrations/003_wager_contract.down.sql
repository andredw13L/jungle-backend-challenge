-- Migration 003 down — remove only the public wager contract additions.
DROP INDEX IF EXISTS idx_wager_reference_external;
ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS ck_wager_business_fields;
ALTER TABLE wager_transactions
  DROP COLUMN IF EXISTS reference_external_transaction_id,
  DROP COLUMN IF EXISTS game_id,
  DROP COLUMN IF EXISTS round_id,
  DROP COLUMN IF EXISTS player_id;
