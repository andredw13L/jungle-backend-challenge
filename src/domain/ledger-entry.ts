import { Decimal } from 'decimal.js';
import { Money } from './money';
import { InvalidLedgerEntryError } from './errors';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface LedgerEntryProps {
  direction: LedgerDirection;
  value: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletId: string;
  transactionId: string;
  createdAt: Date;
}

/**
 * LedgerEntry — immutable, audit-trail value object. Every balance change
 * MUST produce exactly one entry whose direction and value transform
 * balanceBefore into balanceAfter — see financial-domain spec.
 *
 * The arithmetical invariant lives here so the domain rejects bad entries
 * even before PostgreSQL CHECK constraints get to see them.
 */
export class LedgerEntry {
  private constructor(public readonly props: LedgerEntryProps) {}

  static record(props: {
    direction: LedgerDirection;
    value: Money;
    balanceBefore: Money;
    walletId: string;
    transactionId: string;
    at: Date;
  }): LedgerEntry {
    if (props.value.isZero() || props.value.isNegative()) {
      throw new InvalidLedgerEntryError('ledger value must be positive', {
        value: props.value.amount,
      });
    }
    // ponytail: do the arithmetic on Decimal so a negative result does not
    // surface as `InvalidMoneyError` from Money.create; the domain wants
    // `InvalidLedgerEntryError` here.
    const candidate =
      props.direction === 'DEBIT'
        ? new Decimal(props.balanceBefore.amount).minus(props.value.amount)
        : new Decimal(props.balanceBefore.amount).plus(props.value.amount);
    if (candidate.isNegative()) {
      throw new InvalidLedgerEntryError(
        'resulting balance would be negative',
        { balanceAfter: candidate.toFixed(2) },
      );
    }
    const balanceAfter = Money.create({
      amount: candidate.toFixed(2),
      currency: props.balanceBefore.currency,
    });
    return LedgerEntry.fromProps({
      direction: props.direction,
      value: props.value,
      balanceBefore: props.balanceBefore,
      balanceAfter,
      walletId: props.walletId,
      transactionId: props.transactionId,
      createdAt: props.at,
    });
  }

  static rehydrate(props: LedgerEntryProps): LedgerEntry {
    return LedgerEntry.fromProps(props);
  }

  private static fromProps(props: LedgerEntryProps): LedgerEntry {
    const entry = new LedgerEntry(Object.freeze({ ...props }));
    return Object.freeze(entry) as LedgerEntry;
  }
}