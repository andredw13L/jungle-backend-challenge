/**
 * Typed domain errors. Each carries a stable machine-readable `code` so the
 * HTTP layer (slice 5) and the Outbox serializer (slice 8) can produce
 * stable failure codes without scattering string literals — see ADR-0006.
 */

export type DomainErrorCode =
  | 'INVALID_MONEY_AMOUNT'
  | 'INVALID_MONEY_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_LEDGER_ENTRY'
  | 'INVALID_WAGER'
  | 'INVALID_WAGER_TRANSITION';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(
    public readonly field: 'amount' | 'currency',
    public readonly value: string,
  ) {
    super(
      field === 'amount' ? 'INVALID_MONEY_AMOUNT' : 'INVALID_MONEY_CURRENCY',
      `Invalid Money ${field}: ${value}`,
      { field, value },
    );
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(
    public readonly expected: string,
    public readonly received: string,
  ) {
    super('CURRENCY_MISMATCH', `Currency mismatch: ${expected} vs ${received}`, {
      expected,
      received,
    });
    this.name = 'CurrencyMismatchError';
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(
    public readonly currentBalance: string,
    public readonly requestedDebit: string,
  ) {
    super(
      'INSUFFICIENT_FUNDS',
      `Insufficient funds: ${currentBalance} < ${requestedDebit}`,
      { currentBalance, requestedDebit },
    );
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(reason: string, detail?: Record<string, unknown>) {
    super('INVALID_LEDGER_ENTRY', reason, detail);
    this.name = 'InvalidLedgerEntryError';
  }
}

export class InvalidWagerError extends DomainError {
  constructor(reason: string, detail?: Record<string, unknown>) {
    super('INVALID_WAGER', reason, detail);
    this.name = 'InvalidWagerError';
  }
}

export class InvalidWagerTransitionError extends DomainError {
  constructor(
    public readonly fromStatus: string,
    public readonly toStatus: string,
  ) {
    super(
      'INVALID_WAGER_TRANSITION',
      `Cannot transition WagerTransaction from ${fromStatus} to ${toStatus}`,
      { fromStatus, toStatus },
    );
    this.name = 'InvalidWagerTransitionError';
  }
}