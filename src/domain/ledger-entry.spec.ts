import { describe, expect, test } from 'bun:test';
import { LedgerEntry } from './ledger-entry';
import { InvalidLedgerEntryError } from './errors';
import { Money } from './money';

const BRL = (amount: string) => Money.create({ amount, currency: 'BRL' });

describe('LedgerEntry', () => {
  const baseProps = {
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    at: new Date('2026-01-01T00:00:00Z'),
  };

  test('records a DEBIT that takes 100.00 -> 20.00', () => {
    const entry = LedgerEntry.record({
      direction: 'DEBIT',
      value: BRL('80.00'),
      balanceBefore: BRL('100.00'),
      ...baseProps,
    });
    expect(entry.props.balanceBefore.amount).toBe('100.00');
    expect(entry.props.balanceAfter.amount).toBe('20.00');
    expect(entry.props.value.amount).toBe('80.00');
    expect(entry.props.direction).toBe('DEBIT');
  });

  test('records a CREDIT that takes 20.00 -> 100.00', () => {
    const entry = LedgerEntry.record({
      direction: 'CREDIT',
      value: BRL('80.00'),
      balanceBefore: BRL('20.00'),
      ...baseProps,
    });
    expect(entry.props.balanceAfter.amount).toBe('100.00');
  });

  test('rejects zero or negative value', () => {
    expect(() =>
      LedgerEntry.record({
        direction: 'DEBIT',
        value: BRL('0.00'),
        balanceBefore: BRL('100.00'),
        ...baseProps,
      }),
    ).toThrow(InvalidLedgerEntryError);
    // ponytail: Money.create refuses negative input; rehydrate trusts
    // already-validated state so we can construct the negative fixture
    // LedgerEntry.record is meant to reject.
    expect(() =>
      LedgerEntry.record({
        direction: 'CREDIT',
        value: Money.rehydrate({ amount: '-1.00', currency: 'BRL' }),
        balanceBefore: BRL('100.00'),
        ...baseProps,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a debit that would produce a negative balance', () => {
    expect(() =>
      LedgerEntry.record({
        direction: 'DEBIT',
        value: BRL('150.00'),
        balanceBefore: BRL('100.00'),
        ...baseProps,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('is frozen — no mutation', () => {
    const entry = LedgerEntry.record({
      direction: 'DEBIT',
      value: BRL('10.00'),
      balanceBefore: BRL('100.00'),
      ...baseProps,
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.props)).toBe(true);
  });

  test('rehydrate trusts persisted arithmetic', () => {
    const entry = LedgerEntry.rehydrate({
      direction: 'CREDIT',
      value: BRL('80.00'),
      balanceBefore: BRL('20.00'),
      balanceAfter: BRL('100.00'),
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(entry.props.balanceAfter.amount).toBe('100.00');
  });
});