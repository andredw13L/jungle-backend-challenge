## ADDED Requirements

### Requirement: Create Wallet atomically
`POST /wallets` MUST create at most one Wallet per player and currency and MUST atomically persist any positive opening balance, its internal OPENING transaction, one CREDIT Ledger entry and related Outbox events.

#### Scenario: Positive opening balance
- **WHEN** a valid player creates a Wallet with `1000.00 BRL`
- **THEN** the response is `201`, version is 1, balance is `1000.00`, and the database contains one OPENING transaction and one matching CREDIT entry in the same commit

#### Scenario: Zero opening balance
- **WHEN** a Wallet is created with `0.00 BRL`
- **THEN** version is 1 and no OPENING transaction or Ledger entry is created

#### Scenario: Duplicate Wallet
- **WHEN** the same player and currency are created concurrently more than once
- **THEN** exactly one Wallet exists and every loser receives a `409` conflict

### Requirement: Query Wallet
`GET /wallets/:walletId` MUST return the Wallet identifier, player, exact balance and version, and MUST return `404` for an unknown identifier.

#### Scenario: Existing Wallet
- **WHEN** a known Wallet is queried
- **THEN** its current persisted balance and version are returned as decimal strings

#### Scenario: Missing Wallet
- **WHEN** an unknown Wallet identifier is queried
- **THEN** the response is `404` with a stable machine-readable code

### Requirement: Page immutable Ledger
`GET /wallets/:walletId/ledger` MUST return reverse-chronological entries using an opaque stable cursor, a default limit of 50 and a maximum limit of 100.

#### Scenario: Next page remains stable
- **WHEN** a client requests the next page using the Base64URL `{createdAt,id}` cursor while newer entries are inserted
- **THEN** the query uses keyset ordering and neither skips nor repeats older entries

#### Scenario: Invalid pagination
- **WHEN** the cursor is malformed or the limit is outside the accepted range
- **THEN** the response is `422` and no query is executed with untrusted cursor values

### Requirement: Reconcile Wallet and Ledger
`POST /wallets/:walletId/reconciliation` MUST calculate the Ledger balance with exact PostgreSQL arithmetic, compare it with the stored balance, report the difference and entry count, and MUST NOT repair a divergence.

#### Scenario: Consistent Wallet
- **WHEN** the Ledger reconstructs the stored balance
- **THEN** the response reports equal exact values, zero difference and `consistent: true`

#### Scenario: Divergent Wallet
- **WHEN** a test fixture creates a stored/Ledger mismatch
- **THEN** the response reports `consistent: false`, emits a structured log and metric, and leaves all financial rows unchanged
