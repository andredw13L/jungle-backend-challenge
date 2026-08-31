-- Migration 004 — transactional Inbox for the SQS command consumer (slice 7).
-- The `inbox` table created in 001 was a stub (payload + received_at only).
-- consumer can deduplicate identical redeliveries, detect conflicting bodies,
-- and classify messages for DLQ redirection — all durable in PostgreSQL.
-- Existing rows are preserved while the 001 stub is evolved in place.
ALTER TABLE inbox
    ADD COLUMN body_hash         text,
    ADD COLUMN received_count    integer NOT NULL DEFAULT 0,
    ADD COLUMN first_received_at timestamptz,
    ADD COLUMN last_received_at  timestamptz,
    ADD COLUMN correlation_id    text;

UPDATE inbox
SET body_hash = md5(payload::text),
    received_count = 1,
    first_received_at = received_at,
    last_received_at = received_at;

ALTER TABLE inbox
    ALTER COLUMN body_hash SET NOT NULL,
    ALTER COLUMN first_received_at SET NOT NULL,
    ALTER COLUMN first_received_at SET DEFAULT now(),
    ALTER COLUMN last_received_at SET NOT NULL,
    ALTER COLUMN last_received_at SET DEFAULT now(),
    ALTER COLUMN payload SET DEFAULT '{}'::jsonb;
