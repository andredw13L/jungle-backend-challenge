import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/**
 * Money — exact, immutable, scale-fixed decimal value object.
 *
 * Construction rules (financial-domain spec):
 *
 * - `amount` is a decimal string with at most 2 fractional digits, e.g.
 *   `"0.10"`, `"25.00"`. Integers like `"25"` are normalised to `"25.00"`.
 * - Empty, negative, scientific notation, leading-zero (`"007"`), and more
 *   than two fractional digits are rejected at the create boundary.
 * - `currency` is a 3-letter ISO-4217 code (e.g. `"BRL"`).
 * - Arithmetic rejects mismatched currencies.
 *
 * The Money type NEVER uses JavaScript `number` for state or arithmetic;
 * decimal.js keeps the decimal scale exact across `+`, `-`, and `eq`.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type MoneyProps = { amount: string; currency: string };

export class Money {
  private constructor(
    public readonly amount: string,
    public readonly currency: string,
  ) {}

  /**
   * Create a new Money. Validates amount and currency, normalises the
   * amount to scale 2 (e.g. `"25"` → `"25.00"`, `"0.1"` → `"0.10"`),
   * and freezes the result.
   */
  static create(props: MoneyProps): Money {
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError('amount', props.amount);
    }
    if (!CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError('currency', props.currency);
    }
    const normalized = new Decimal(props.amount).toFixed(2);
    return Object.freeze(new Money(normalized, props.currency)) as Money;
  }

  /**
   * Rehydrate Money from already-persisted state. Skips validation — the
   * PostgreSQL NUMERIC(18,2) column guarantees the format.
   */
  static rehydrate(props: MoneyProps): Money {
    return Object.freeze(new Money(props.amount, props.currency)) as Money;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create({
      amount: new Decimal(this.amount).plus(other.amount).toFixed(2),
      currency: this.currency,
    });
  }

  sub(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create({
      amount: new Decimal(this.amount).minus(other.amount).toFixed(2),
      currency: this.currency,
    });
  }

  eq(other: Money): boolean {
    this.assertSameCurrency(other);
    return new Decimal(this.amount).equals(other.amount);
  }

  gte(other: Money): boolean {
    this.assertSameCurrency(other);
    return new Decimal(this.amount).greaterThanOrEqualTo(other.amount);
  }

  gt(other: Money): boolean {
    this.assertSameCurrency(other);
    return new Decimal(this.amount).greaterThan(other.amount);
  }

  isZero(): boolean {
    return new Decimal(this.amount).isZero();
  }

  isNegative(): boolean {
    return new Decimal(this.amount).isNegative();
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}