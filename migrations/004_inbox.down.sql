-- Restore the 001 inbox shape so `down -> up` is a clean round-trip.
DROP TABLE IF EXISTS inbox;

CREATE TABLE inbox (
    consumer_name text NOT NULL,
    message_id    text NOT NULL,
    payload       jsonb NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz,
    PRIMARY KEY (consumer_name, message_id)
);
