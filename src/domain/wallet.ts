import { Decimal } from 'decimal.js';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
} from './errors';
import { LedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletSnapshot {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Wallet — aggregate that owns the balance. Invariants:
 *
 * - One Wallet per `(playerId, currency)`.
 * - `version` starts at 1 and increments only when the balance changes.
 * - The balance is NEVER negative.
 * - `rehydrate` trusts persisted state; `apply` enforces invariants.
 *
 * Per spec: LOSS/REJECTED do NOT touch the Wallet — only `debit` and `credit`
 * mutate the balance. `rehydrate` exists for the persistence layer (slice 3).
 */
export class Wallet {
  private constructor(public readonly snapshot: WalletSnapshot) {}

  /**
   * Open a new wallet with an initial balance. Returns the wallet and the
   * opening ledger entry that records the balance change in a single
   * transaction (slice 3 wires this to the persistence layer).
   */
  static open(props: {
    id: string;
    playerId: string;
    currency: string;
    initialBalance: Money;
    openedAt: Date;
  }): { wallet: Wallet; opening: LedgerEntry } {
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

  debit(value: Money, transactionId: string, at: Date): ApplyResult {
    return this.apply('DEBIT', value, transactionId, at);
  }

  credit(value: Money, transactionId: string, at: Date): ApplyResult {
    return this.apply('CREDIT', value, transactionId, at);
  }

  private apply(
    direction: 'DEBIT' | 'CREDIT',
    value: Money,
    transactionId: string,
    at: Date,
  ): ApplyResult {
    if (value.currency !== this.snapshot.currency) {
      throw new CurrencyMismatchError(this.snapshot.currency, value.currency);
    }
    // ponytail: check the candidate on Decimal so we can raise the domain-
    // specific INSUFFICIENT_FUNDS instead of leaking InvalidMoneyError from
    // Money.create.
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

interface ApplyResult {
  wallet: Wallet;
  entry: LedgerEntry;
}