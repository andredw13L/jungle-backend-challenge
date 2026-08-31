-- Restore the 001 inbox shape without dropping the table.
ALTER TABLE inbox
    ALTER COLUMN payload DROP DEFAULT,
    DROP COLUMN body_hash,
    DROP COLUMN received_count,
    DROP COLUMN first_received_at,
    DROP COLUMN last_received_at,
    DROP COLUMN correlation_id;
