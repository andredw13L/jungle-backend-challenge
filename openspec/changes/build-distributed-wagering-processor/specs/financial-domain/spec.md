## ADDED Requirements

### Requirement: Exact immutable Money
The system MUST represent monetary amounts as decimal strings with fixed scale 2 at contracts and PostgreSQL boundaries, MUST calculate with an exact decimal implementation, and MUST NOT use JavaScript `number` for monetary state or arithmetic.

#### Scenario: Exact decimal arithmetic
- **WHEN** `0.10 BRL` and `0.20 BRL` are added
- **THEN** the result is a new Money value serialized as `{"amount":"0.30","currency":"BRL"}` and both operands remain unchanged

#### Scenario: Invalid external amount
- **WHEN** an external contract contains an empty value, negative value, scientific notation, leading zero such as `007`, or more than two decimal places
- **THEN** validation rejects it before financial state is created

#### Scenario: Normalize accepted scale without silent rounding
- **WHEN** an external amount is `25` or `25.0`
- **THEN** it serializes as `25.00`, while `25.001` is rejected rather than rounded

#### Scenario: Currency conflict
- **WHEN** arithmetic is attempted between different currencies
- **THEN** the domain rejects the operation with a stable currency mismatch outcome

### Requirement: Wallet invariants
A Wallet MUST belong to one player and currency, MUST begin at version 1, MUST never expose a negative balance, and MUST increment its version only when its balance changes.

#### Scenario: Successful debit
- **WHEN** a Wallet with `100.00 BRL` is debited by `80.00 BRL`
- **THEN** it returns the before/after values `100.00` and `20.00` and increments version exactly once

#### Scenario: Insufficient balance
- **WHEN** a debit exceeds the available balance
- **THEN** the Wallet remains unchanged and produces the `INSUFFICIENT_FUNDS` business rejection

#### Scenario: Rehydration
- **WHEN** a Wallet is rehydrated from persisted state
- **THEN** its trusted state is reconstructed without replaying creation or transition validation

### Requirement: Auditable Ledger entry
Every balance change MUST have exactly one immutable Ledger entry whose direction and amount transform `balanceBefore` into `balanceAfter`; operations without a balance effect MUST NOT create an entry.

#### Scenario: Balanced entry
- **WHEN** a `DEBIT` entry describes `100.00 - 80.00`
- **THEN** it is valid only with `balanceAfter` equal to `20.00`

#### Scenario: No entry for non-financial outcome
- **WHEN** a LOSS or REJECTED transaction is recorded
- **THEN** no Ledger entry is created and the Wallet version is unchanged

### Requirement: Wager transaction state machine
WagerTransaction MUST support OPENING, BET, WIN, LOSS, REFUND and ROLLBACK, MUST require valid references for reversal kinds, and MUST prevent PROCESSED, REJECTED and FAILED states from transitioning again.

#### Scenario: Internal opening
- **WHEN** a positive initial Wallet balance is created
- **THEN** an internal OPENING transaction can become PROCESSED but the same kind cannot be submitted through HTTP or SQS

#### Scenario: Terminal transaction
- **WHEN** code attempts to transition a terminal transaction
- **THEN** an invalid-state programming error is raised and no new financial effect occurs

#### Scenario: Required reference
- **WHEN** REFUND or ROLLBACK is created without a provider reference
- **THEN** the request is rejected as invalid before persistence

### Requirement: Controlled domain construction
Domain entities MUST use private or protected constructors, MUST expose creation factories that validate new state, and MUST expose rehydration factories that trust already persisted state without replaying transition rules.

#### Scenario: Creation and rehydration have distinct semantics
- **WHEN** identical raw values enter through a creation factory and a rehydration factory
- **THEN** creation enforces new-operation invariants while rehydration reconstructs the trusted persisted snapshot

### Requirement: Typed integration events
Integration events MUST use an abstract versioned envelope and concrete event types, MUST serialize dates as ISO-8601 and Money as decimal-string properties, and MUST remain immutable after creation.

#### Scenario: Wallet balance event
- **WHEN** a transaction changes a Wallet balance
- **THEN** `WalletBalanceChanged` contains event identity, correlation, Wallet version, direction and exact before/after Money properties
