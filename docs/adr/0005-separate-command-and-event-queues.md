# Separate command and event queues

Provider commands arrive through `wager-transactions.fifo` with its DLQ, while Outbox events are published to `wager-events.fifo`; both group messages by Wallet. FIFO ordering and short-window deduplication are delivery optimizations only—PostgreSQL constraints, Inbox and idempotency remain the correctness mechanisms.
