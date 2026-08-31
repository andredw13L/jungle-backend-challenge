import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';
import { Money } from './money';

describe('Money', () => {
  test('create stores the exact decimal string', () => {
    const m = Money.create({ amount: '0.30', currency: 'BRL' });
    expect(m.amount).toBe('0.30');
    expect(m.currency).toBe('BRL');
  });

  test('create is immutable', () => {
    const m = Money.create({ amount: '0.30', currency: 'BRL' });
    expect(Object.isFrozen(m)).toBe(true);
  });

  test('add is exact: 0.10 + 0.20 = 0.30', () => {
    const a = Money.create({ amount: '0.10', currency: 'BRL' });
    const b = Money.create({ amount: '0.20', currency: 'BRL' });
    const sum = a.add(b);
    expect(sum.amount).toBe('0.30');
    // operands unchanged (financial-domain spec).
    expect(a.amount).toBe('0.10');
    expect(b.amount).toBe('0.20');
  });

  test('sub is exact and does not round', () => {
    const a = Money.create({ amount: '100.00', currency: 'BRL' });
    const b = Money.create({ amount: '80.00', currency: 'BRL' });
    expect(a.sub(b).amount).toBe('20.00');
  });

  test('arithmetic with different currencies throws', () => {
    const a = Money.create({ amount: '1.00', currency: 'BRL' });
    const b = Money.create({ amount: '1.00', currency: 'USD' });
    expect(() => a.add(b)).toThrow(CurrencyMismatchError);
    expect(() => a.sub(b)).toThrow(CurrencyMismatchError);
    expect(() => a.eq(b)).toThrow(CurrencyMismatchError);
  });

  test('integer input is normalised to 2 decimal places', () => {
    expect(Money.create({ amount: '25', currency: 'BRL' }).amount).toBe('25.00');
    expect(Money.create({ amount: '25.0', currency: 'BRL' }).amount).toBe('25.00');
    expect(Money.create({ amount: '0', currency: 'BRL' }).amount).toBe('0.00');
  });

  test('rejects empty, negative, scientific, leading-zero, and >2 decimals', () => {
    for (const bad of ['', '   ', '-1', '1e2', '007', '25.001', '.5', '5.']) {
      expect(() => Money.create({ amount: bad, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
  });

  test('rejects lowercase or malformed currency', () => {
    expect(() => Money.create({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.create({ amount: '1.00', currency: 'BRLX' })).toThrow(InvalidMoneyError);
    expect(() => Money.create({ amount: '1.00', currency: '' })).toThrow(InvalidMoneyError);
  });

  test('comparison helpers', () => {
    const a = Money.create({ amount: '10.00', currency: 'BRL' });
    const b = Money.create({ amount: '10.00', currency: 'BRL' });
    const c = Money.create({ amount: '9.99', currency: 'BRL' });
    expect(a.eq(b)).toBe(true);
    expect(a.gt(c)).toBe(true);
    expect(a.gte(b)).toBe(true);
    expect(c.gt(a)).toBe(false);
  });

  test('zero and negative detection', () => {
    const zero = Money.create({ amount: '0.00', currency: 'BRL' });
    expect(zero.isZero()).toBe(true);
    expect(zero.isNegative()).toBe(false);
  });

  test('rehydrate trusts persisted state', () => {
    const m = Money.rehydrate({ amount: '999.99', currency: 'BRL' });
    expect(m.amount).toBe('999.99');
    expect(Object.isFrozen(m)).toBe(true);
  });

  test('serializes as {amount, currency} without number fields', () => {
    const json = JSON.stringify(Money.create({ amount: '1.00', currency: 'BRL' }));
    expect(json).toBe('{"amount":"1.00","currency":"BRL"}');
  });
});