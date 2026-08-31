import { Decimal } from 'decimal.js';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
} from './errors';
import { LedgerEntry } from './ledger-entry';
import { Money } from './money';

/**
 * Wallet.open() now returns `opening: LedgerEntry | null` — a zero initial
 * balance produces no OPENING transaction and no Ledger entry, per the
 * wallet-lifecycle spec ("Saldo inicial zero" scenario).
 *
 * The persistence layer (slice 3) checks `opening` and persists the entry
 * only when non-null.
 */
export interface WalletSnapshot {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenResult {
  wallet: Wallet;
  opening: LedgerEntry | null;
}

export class Wallet {
  private constructor(public readonly snapshot: WalletSnapshot) {}

  static open(props: {
    id: string;
    playerId: string;
    currency: string;
    initialBalance: Money;
    openedAt: Date;
  }): OpenResult {
    if (props.initialBalance.isZero()) {
      const wallet = new Wallet(
        Object.freeze({
          id: props.id,
          playerId: props.playerId,
          currency: props.currency,
          balance: props.initialBalance,
          version: 1,
          createdAt: props.openedAt,
          updatedAt: props.openedAt,
        }),
      );
      return {
        wallet: Object.freeze(wallet) as Wallet,
        opening: null,
      };
    }
    const opening = LedgerEntry.record({
      direction: 'CREDIT',
      value: props.initialBalance,
      balanceBefore: Money.create({ amount: '0', currency: props.currency }),
      walletId: props.id,
      transactionId: props.id,
      at: props.openedAt,
    });
    const wallet = new Wallet(
      Object.freeze({
        id: props.id,
        playerId: props.playerId,
        currency: props.currency,
        balance: props.initialBalance,
        version: 1,
        createdAt: props.openedAt,
        updatedAt: props.openedAt,
      }),
    );
    return {
      wallet: Object.freeze(wallet) as Wallet,
      opening,
    };
  }

  static rehydrate(props: WalletSnapshot): Wallet {
    return Object.freeze(new Wallet(Object.freeze({ ...props }))) as Wallet;
  }

  debit(value: Money, transactionId: string, at: Date) {
    return this.apply('DEBIT', value, transactionId, at);
  }

  credit(value: Money, transactionId: string, at: Date) {
    return this.apply('CREDIT', value, transactionId, at);
  }

  private apply(
    direction: 'DEBIT' | 'CREDIT',
    value: Money,
    transactionId: string,
    at: Date,
  ) {
    if (value.currency !== this.snapshot.currency) {
      throw new CurrencyMismatchError(this.snapshot.currency, value.currency);
    }
    // Decimal-based negative check (see ledger-entry.ts comment).
    const candidate =
      direction === 'DEBIT'
        ? new Decimal(this.snapshot.balance.amount).minus(value.amount)
        : new Decimal(this.snapshot.balance.amount).plus(value.amount);
    if (direction === 'DEBIT' && candidate.isNegative()) {
      throw new InsufficientFundsError(
        this.snapshot.balance.amount,
        value.amount,
      );
    }
    const entry = LedgerEntry.record({
      direction,
      value,
      balanceBefore: this.snapshot.balance,
      walletId: this.snapshot.id,
      transactionId,
      at,
    });
    const next = Object.freeze({
      ...this.snapshot,
      balance: entry.props.balanceAfter,
      version: this.snapshot.version + 1,
      updatedAt: at,
    });
    return {
      wallet: Object.freeze(new Wallet(next)) as Wallet,
      entry,
    };
  }
}