-- Migration 001 — wagering schema
-- Slice 3 creates five tables with named constraints, an append-only trigger
-- on the Ledger, and the SKIP LOCKED index that the Outbox publisher will
-- rely on (slice 8).

CREATE TABLE wallets (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    player_id           text NOT NULL,
    currency            char(3) NOT NULL,
    balance_amount      numeric(18,2) NOT NULL DEFAULT 0,
    balance_currency    char(3) NOT NULL,
    version             integer NOT NULL DEFAULT 1,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_wallet_balance_nonneg    CHECK (balance_amount >= 0),
    CONSTRAINT ck_wallet_currency_match    CHECK (currency = balance_currency),
    CONSTRAINT uq_wallet_player_currency   UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
    id                       uuid PRIMARY KEY DEFAULT uuidv7(),
    type                     text NOT NULL CHECK (type IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
    status                   text NOT NULL CHECK (status IN ('PENDING','PROCESSED','REJECTED','FAILED')),
    wallet_id                uuid NOT NULL REFERENCES wallets(id),
    provider_id              text NOT NULL,
    external_transaction_id  text NOT NULL,
    amount_amount            numeric(18,2) NOT NULL,
    amount_currency          char(3) NOT NULL,
    reference                uuid,
    payload_hash             text NOT NULL,
    response_payload         jsonb,
    failure_code             text,
    reference_attempts       integer NOT NULL DEFAULT 0,
    next_retry_at            timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    processed_at             timestamptz,
    idempotency_key          text NOT NULL,
    CONSTRAINT ck_wager_amount_currency     CHECK (amount_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT uq_wager_idempotency_key     UNIQUE (idempotency_key),
    CONSTRAINT uq_wager_provider_external   UNIQUE (provider_id, external_transaction_id),
    CONSTRAINT ck_wager_terminal_processed  CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
    CONSTRAINT ck_wager_terminal_rejected   CHECK (status <> 'REJECTED' OR processed_at IS NOT NULL),
    CONSTRAINT ck_wager_terminal_failed     CHECK (status <> 'FAILED' OR processed_at IS NOT NULL)
);
CREATE INDEX idx_wager_wallet_created ON wager_transactions (wallet_id, created_at DESC);
CREATE INDEX idx_wager_reference      ON wager_transactions (reference) WHERE reference IS NOT NULL;

CREATE TABLE wallet_ledger_entries (
    id                       uuid PRIMARY KEY DEFAULT uuidv7(),
    direction                text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
    value_amount             numeric(18,2) NOT NULL,
    value_currency           char(3) NOT NULL,
    balance_before_amount    numeric(18,2) NOT NULL,
    balance_before_currency  char(3) NOT NULL,
    balance_after_amount     numeric(18,2) NOT NULL,
    balance_after_currency   char(3) NOT NULL,
    wallet_id                uuid NOT NULL REFERENCES wallets(id),
    transaction_id           uuid NOT NULL REFERENCES wager_transactions(id),
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_ledger_value_positive  CHECK (value_amount > 0),
    CONSTRAINT ck_ledger_currency        CHECK (balance_before_currency = balance_after_currency AND balance_before_currency = value_currency),
    CONSTRAINT ck_ledger_nonneg          CHECK (balance_after_amount >= 0),
    CONSTRAINT ck_ledger_arithmetic      CHECK (
      (direction = 'CREDIT' AND balance_after_amount = balance_before_amount + value_amount) OR
      (direction = 'DEBIT'  AND balance_after_amount = balance_before_amount - value_amount)
    ),
    CONSTRAINT uq_ledger_tx_wallet       UNIQUE (transaction_id, wallet_id)
);
CREATE INDEX idx_ledger_wallet_created ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TABLE inbox (
    consumer_name text NOT NULL,
    message_id    text NOT NULL,
    payload       jsonb NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz,
    PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    event_id         uuid NOT NULL,
    event_type       text NOT NULL,
    schema_version   integer NOT NULL DEFAULT 1,
    payload          jsonb NOT NULL,
    status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PUBLISHED','FAILED')),
    attempts         integer NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_error       text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    published_at     timestamptz,
    CONSTRAINT uq_outbox_event_id UNIQUE (event_id)
);
CREATE INDEX idx_outbox_pending ON outbox (next_attempt_at) WHERE status = 'PENDING';