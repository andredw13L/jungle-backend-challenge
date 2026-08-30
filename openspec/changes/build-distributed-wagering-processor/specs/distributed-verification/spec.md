## ADDED Requirements

### Requirement: Verify pure financial behavior
The unit suite MUST cover Money validation and operations, Wallet invariants, every wager kind and transition, reference rules, currency conflict, Ledger arithmetic and divergent idempotency payloads.

#### Scenario: Unit suite execution
- **WHEN** `bun test` runs without infrastructure-specific filters
- **THEN** every pure domain requirement is exercised without mocking the domain implementation

### Requirement: Verify PostgreSQL and SQS integration
Integration tests MUST use the real Compose PostgreSQL and LocalStack services, MUST reset shared state deterministically, and MUST cover migrations, constraints, atomicity, Inbox/redelivery, Outbox publishers, retry/DLQ and restart recovery.

#### Scenario: Migration lifecycle
- **WHEN** migrations run up, down and up against a clean database
- **THEN** the expected schema and named constraints are recreated without manual intervention

#### Scenario: Atomic rollback
- **WHEN** a forced failure occurs before the financial transaction commits
- **THEN** Wallet, wager, Ledger, Inbox and Outbox all retain their prior state

### Requirement: Prove idempotency under parallel delivery
The distributed suite MUST send one BET fifty times concurrently across at least three OS processes and MUST prove a single financial effect.

#### Scenario: Fifty identical submissions
- **WHEN** fifty requests with one idempotency key are released together across ports 3101–3103
- **THEN** one original and forty-nine replays return, final balance reflects one debit, one Ledger entry exists and one financial event set exists

### Requirement: Prove competing balance correctness
The distributed suite MUST run the mandatory `100.00 BRL` Wallet and two concurrent `80.00 BRL` BET scenario against shared PostgreSQL.

#### Scenario: Two bets compete
- **WHEN** different processes submit both BETs concurrently
- **THEN** one is PROCESSED, one is REJECTED, balance is `20.00`, exactly one DEBIT exists and Ledger reconstruction equals balance

### Requirement: Prove independent Wallet progress
The distributed suite MUST demonstrate that operations on distinct Wallets progress without a global lock.

#### Scenario: Different Wallets in parallel
- **WHEN** three processes operate on distinct Wallets through a synchronized start
- **THEN** all outcomes are correct and observed lock contention is scoped to individual Wallet identifiers

### Requirement: Prove three independent application instances
The distributed suite MUST start at least three Bun OS processes with distinct PIDs, ports, Nest containers and connection pools sharing only PostgreSQL and SQS.

#### Scenario: All instances participate
- **WHEN** the suite waits for readiness and distributes requests round-robin
- **THEN** every PID handles work, remains independently health-checkable and correctness does not depend on process memory

### Requirement: Prove recovery after commit before acknowledgement
The suite MUST deterministically terminate a consumer process after PostgreSQL commit and before SQS acknowledgement.

#### Scenario: Consumer crashes before ack
- **WHEN** fault injection kills that process in the post-commit/pre-ack seam
- **THEN** another process receives the message and Inbox/idempotency prevent another financial effect

### Requirement: Prove concurrent Outbox publication
The suite MUST run at least two publishers over the same Outbox and verify eventual publication without lost rows.

#### Scenario: Two publishers
- **WHEN** both publishers start on a backlog simultaneously
- **THEN** every durable event is published, each row reaches published state and duplicate delivery remains identifiable by event ID

### Requirement: Prove out-of-order reversal recovery
The suite MUST deliver REFUND or ROLLBACK before its reference and verify both eventual success and exhausted-reference rejection.

#### Scenario: Reversal precedes reference
- **WHEN** the reversal is PENDING_REFERENCE and its valid reference arrives later
- **THEN** scheduled processing completes it exactly once with a reconciled Wallet

### Requirement: Prove restart consistency
The suite MUST stop and restart application processes while committed state, unacknowledged messages or unpublished Outbox rows exist.

#### Scenario: Full service restart
- **WHEN** all application processes restart against unchanged PostgreSQL and SQS
- **THEN** processing resumes and every Wallet balance equals its Ledger reconstruction after quiescence

### Requirement: Assert the final financial invariant
Every integration or concurrency test that can change a Wallet MUST finish by comparing stored balance with the exact balance reconstructed from its immutable Ledger.

#### Scenario: Financial test teardown
- **WHEN** a financial scenario reaches its terminal observable state
- **THEN** `wallet.balance == reconstructed ledger balance` is asserted before the scenario passes
