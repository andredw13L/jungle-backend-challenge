# Use a transactional inbox and outbox

HTTP and SQS call the same `ProcessWager` interface, and PostgreSQL atomically persists the transaction, Wallet change, Ledger entry, optional Inbox record and Outbox events. SQS acknowledgement and event publication happen only after commit, so at-least-once delivery may duplicate messages but cannot duplicate financial effects.
