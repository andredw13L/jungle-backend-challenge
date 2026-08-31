-- Migration 004 — transactional Inbox for the SQS command consumer (slice 7).
-- The `inbox` table created in 001 was a stub (payload + received_at only).
-- Slice 7 needs delivery accounting (received_count, body_hash) so the
-- consumer can deduplicate identical redeliveries, detect conflicting bodies,
-- and classify messages for DLQ redirection — all durable in PostgreSQL.
DROP TABLE IF EXISTS inbox;

CREATE TABLE inbox (
    consumer_name      text        NOT NULL,
    message_id         text        NOT NULL,
    body_hash          text        NOT NULL,           -- canonical hash of business fields (same scheme as wagerPayloadHash)
    received_count     integer     NOT NULL DEFAULT 0,
    first_received_at  timestamptz NOT NULL DEFAULT now(),
    last_received_at   timestamptz NOT NULL DEFAULT now(),
    processed_at       timestamptz NULL,
    correlation_id     text        NULL,
    PRIMARY KEY (consumer_name, message_id)
);
