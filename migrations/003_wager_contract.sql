-- Migration 003 — public wager contract fields.
-- 001/002 remain canonical; this migration only adds durable business data.

ALTER TABLE wager_transactions
  ADD COLUMN player_id text,
  ADD COLUMN round_id text,
  ADD COLUMN game_id text,
  ADD COLUMN reference_external_transaction_id text;

-- Player identity is deterministic from the wallet already stored on every
-- existing row. Round/game are nullable for historical and OPENING rows.
UPDATE wager_transactions wt
SET player_id = w.player_id
FROM wallets w
WHERE w.id = wt.wallet_id
  AND wt.player_id IS NULL;

CREATE INDEX idx_wager_reference_external
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE reference_external_transaction_id IS NOT NULL;
