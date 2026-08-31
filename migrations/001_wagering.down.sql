-- Migration 001 down — reverses the wagering schema
DROP INDEX IF EXISTS idx_outbox_pending;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS inbox;
DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries;
DROP FUNCTION IF EXISTS reject_ledger_mutation();
DROP INDEX IF EXISTS idx_ledger_wallet_created;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP INDEX IF EXISTS idx_wager_reference;
DROP INDEX IF EXISTS idx_wager_wallet_created;
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;