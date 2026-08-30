## ADDED Requirements

### Requirement: Validate wagering contracts
`POST /wagering/transactions` MUST require `Idempotency-Key`, MUST reject unknown fields and malformed identifiers, kinds or Money with `422`, and MUST reject external OPENING operations.

#### Scenario: Valid command
- **WHEN** a complete BET command and idempotency header pass validation
- **THEN** the controller calls `ProcessWager` with normalized business fields and no transport metadata in the payload hash

#### Scenario: Unknown contract field
- **WHEN** a request contains an undeclared property
- **THEN** whitelist validation rejects it with `422/INVALID_PAYLOAD`

### Requirement: Persist idempotency and replay
The system MUST arbitrate idempotency through named PostgreSQL unique constraints, MUST hash RFC 8785 canonical business JSON with SHA-256, and MUST replay the persisted response without repeating effects.

#### Scenario: Identical replay
- **WHEN** the same idempotency key and logical payload are submitted again in a different JSON property order
- **THEN** the canonical hashes match, the original transaction identifier/status/balance are returned with `idempotentReplay: true`, and no Wallet, Ledger or Outbox effect is duplicated

#### Scenario: Conflicting replay
- **WHEN** an existing idempotency key is reused with different business fields
- **THEN** the response is `422/IDEMPOTENCY_CONFLICT` and the original result remains unchanged

#### Scenario: Provider transaction reused under another key
- **WHEN** the same provider and external transaction identifier are submitted with another idempotency key
- **THEN** the request is rejected as a stable external-transaction conflict without a duplicate effect

### Requirement: Serialize balance-changing operations by Wallet
BET, WIN, REFUND and ROLLBACK MUST lock one Wallet row within `READ COMMITTED` before evaluating or changing balance; different Wallets MUST remain independent and no process-local lock may provide correctness.

#### Scenario: Competing bets
- **WHEN** two `80.00 BRL` BETs concurrently target a Wallet containing `100.00 BRL`
- **THEN** exactly one is PROCESSED, one is REJECTED/INSUFFICIENT_FUNDS, final balance is `20.00`, version changes once and exactly one DEBIT entry exists

#### Scenario: Different Wallets
- **WHEN** operations target different Wallet identifiers concurrently
- **THEN** neither waits on a global application lock and both outcomes remain correct

### Requirement: Apply BET, WIN and LOSS rules
BET MUST debit sufficient balance, WIN MUST credit balance, and LOSS MUST record a processed outcome without changing balance or producing a Ledger entry.

#### Scenario: Process BET
- **WHEN** a valid BET has sufficient balance
- **THEN** it is PROCESSED with one DEBIT entry and `WagerTransactionProcessed` plus `WalletBalanceChanged` Outbox events

#### Scenario: Process WIN
- **WHEN** a valid WIN is submitted
- **THEN** it is PROCESSED with one CREDIT entry and the exact new balance

#### Scenario: WIN with optional BET reference
- **WHEN** a WIN identifies a BET reference
- **THEN** the reference must be a matching PROCESSED BET from the same provider, player, Wallet, currency and round before the WIN is credited

#### Scenario: Process LOSS
- **WHEN** a valid LOSS is submitted
- **THEN** it is PROCESSED, balance/version remain unchanged and only `WagerTransactionProcessed` is enqueued

### Requirement: Apply full reversals once
REFUND MUST reverse only a PROCESSED BET; ROLLBACK MUST reverse a PROCESSED BET, WIN or REFUND; the reference MUST match provider, player, Wallet, currency and round; the amount MUST be equal; and each reference/type pair MUST be reversed at most once.

#### Scenario: Valid REFUND
- **WHEN** a REFUND exactly references a matching PROCESSED BET
- **THEN** it credits the original amount once and links the internal reference transaction

#### Scenario: Valid ROLLBACK
- **WHEN** a ROLLBACK exactly references a matching PROCESSED WIN
- **THEN** it creates one inverse DEBIT and becomes PROCESSED

#### Scenario: ROLLBACK direction follows its reference
- **WHEN** a ROLLBACK references a PROCESSED BET, WIN or REFUND
- **THEN** BET produces an inverse CREDIT while WIN and REFUND produce an inverse DEBIT of the full referenced amount

#### Scenario: Invalid reference scope or amount
- **WHEN** reference identity, scope, kind or amount does not satisfy the reversal rules
- **THEN** the transaction becomes REJECTED with the corresponding stable failure code and no Ledger entry

#### Scenario: Reversal would overdraw
- **WHEN** reversing a prior credit would make the Wallet negative
- **THEN** the transaction becomes REJECTED/REVERSAL_WOULD_OVERDRAW and remains auditably persisted

#### Scenario: Concurrent duplicate reversal
- **WHEN** two reversals of the same type race for the same reference
- **THEN** a partial unique index permits at most one effect and the other returns REFERENCE_ALREADY_REVERSED

### Requirement: Query wagering transactions
The system MUST expose transaction lookup by internal identifier and by `(providerId, externalTransactionId)`, returning the persisted status, failure, reference and exact Money or `404` when absent.

#### Scenario: Query processed transaction
- **WHEN** a known transaction is queried through either route
- **THEN** both routes identify the same immutable operation and current persisted outcome

### Requirement: Distinguish outcomes from infrastructure errors
Business rejections MUST return `200` with a stable failure code, pending references MUST return `202`, and transient infrastructure failures MUST return `503` so a provider can safely retry the same idempotency key.

#### Scenario: Insufficient funds is an outcome
- **WHEN** a syntactically valid BET lacks sufficient balance
- **THEN** the response is `200` with status REJECTED and failure code INSUFFICIENT_FUNDS rather than a validation error

#### Scenario: PostgreSQL temporarily unavailable
- **WHEN** processing cannot reach PostgreSQL
- **THEN** the response is `503` and no successful financial outcome is fabricated

#### Scenario: PostgreSQL error classes remain distinct
- **WHEN** PostgreSQL reports a named `23505`, invariant `23514`, or transient `40001`
- **THEN** the system respectively handles the named conflict, raises an invariant alert without hiding the bug, or returns a retryable infrastructure outcome
