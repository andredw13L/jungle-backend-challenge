## ADDED Requirements

### Requirement: Consume SQS commands through the shared processor
The SQS consumer MUST validate the same business contract as HTTP, MUST call `ProcessWager`, MUST long-poll up to ten messages for 20 seconds with configurable visibility, and MUST process Wallet groups concurrently while preserving order within a Wallet group.

#### Scenario: Valid queued command
- **WHEN** a valid `WagerTransactionRequested` message is received
- **THEN** the shared processor produces the same persisted outcome as the equivalent HTTP command and acknowledgement occurs only after commit

#### Scenario: Concurrent Wallet groups
- **WHEN** one receive batch contains messages for different Wallet groups
- **THEN** groups can progress concurrently while messages sharing a `walletId` remain sequential

### Requirement: Deduplicate delivery with a transactional Inbox
The consumer MUST claim `(consumerName,messageId)` in PostgreSQL inside the same transaction as the business effect, MUST compare payload hashes for an existing message, and MUST remain safe when a duplicate uses a new SQS receipt handle.

#### Scenario: Identical redelivery
- **WHEN** a processed message is delivered again with the same message and payload hash
- **THEN** no business effect repeats and the current receipt handle is acknowledged

#### Scenario: Conflicting message identity
- **WHEN** an existing message identifier is reused with a different payload hash
- **THEN** no financial state changes and the permanent conflict is retried only for DLQ redrive

#### Scenario: New message identity with existing wager key
- **WHEN** a redelivery carries a new message identifier but an already processed wager idempotency key
- **THEN** Inbox records the new delivery, wager replay prevents a second effect, and the message is acknowledged after commit

### Requirement: Classify failures for acknowledgement and redrive
Business outcomes and identical duplicates MUST be acknowledged; invalid or permanently conflicting messages MUST remain unacknowledged for a five-receive DLQ policy; transient infrastructure failures MUST remain unacknowledged for retry.

#### Scenario: Invalid message reaches DLQ
- **WHEN** a malformed message is received five times without acknowledgement
- **THEN** LocalStack redrives it to `wager-transactions-dlq.fifo`, the DLQ metric reflects the queued message and no financial row is created

#### Scenario: Business rejection is acknowledged
- **WHEN** a valid queued BET is rejected for insufficient balance
- **THEN** the REJECTED transaction and Outbox event commit and the message is deleted

### Requirement: Recover references delivered out of order
A missing valid reference MUST persist the transaction as PENDING_REFERENCE, MUST enqueue `WagerTransactionPendingReference`, and MUST be reconsidered with configurable exponential backoff until success or exhaustion.

#### Scenario: Reference arrives later
- **WHEN** a REFUND arrives before its BET and the BET commits before a scheduled retry
- **THEN** the retry resolves the reference and applies the REFUND exactly once

#### Scenario: Reference never arrives
- **WHEN** the configured attempt limit is exhausted
- **THEN** the transaction becomes REJECTED/REFERENCE_NOT_FOUND and `WagerTransactionRejected` is enqueued

#### Scenario: Concurrent pending-reference workers
- **WHEN** multiple processes poll the same due pending references
- **THEN** `SKIP LOCKED` assigns each available row to at most one active worker and database guarantees prevent duplicate reversal effects

### Requirement: Publish transactional Outbox events
Financial processing MUST persist required events in the same PostgreSQL transaction, and publishers MUST select one due event with `FOR UPDATE SKIP LOCKED`, publish it to `wager-events.fifo`, and mark it published only after broker success.

#### Scenario: Required event set
- **WHEN** transactions are processed, rejected, pending reference or balance-changing
- **THEN** the Outbox contains the corresponding minimum events from README §11 and `WalletBalanceChanged` exists only when balance changes

#### Scenario: Concurrent publishers
- **WHEN** two publisher processes poll the same pending Outbox rows
- **THEN** `SKIP LOCKED` assigns different available rows and every event is eventually marked published

#### Scenario: Crash after financial commit
- **WHEN** the originating process dies after financial commit and before publication
- **THEN** another publisher discovers and publishes the durable Outbox row

#### Scenario: Crash after broker send
- **WHEN** a publisher dies after SQS accepts an event but before PostgreSQL records publication
- **THEN** a later attempt can deliver the same event identifier again without changing the original financial state

#### Scenario: Broker failure schedules retry
- **WHEN** SQS rejects or times out an Outbox publication
- **THEN** attempts increment, the next attempt uses bounded backoff, the row remains unpublished and its financial transaction remains committed

### Requirement: Shut messaging down safely
On SIGTERM the application MUST stop new polling, await in-flight handlers within a bounded shutdown window, leave unfinished messages unacknowledged or reset their visibility, and close SQS and database clients.

#### Scenario: Shutdown with in-flight message
- **WHEN** SIGTERM arrives during message processing
- **THEN** the process either commits then acknowledges or exits without acknowledgement so another instance can redeliver safely
