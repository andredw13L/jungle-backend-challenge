# Coordinate wallet writes in PostgreSQL

Balance-changing operations use `READ COMMITTED` transactions and `SELECT ... FOR UPDATE` on one Wallet, while `version` records each balance change and outbox publishers use `SKIP LOCKED`. This keeps correctness shared across instances without a global lock; a hot Wallet is deliberately serialized instead of causing an optimistic retry storm.
