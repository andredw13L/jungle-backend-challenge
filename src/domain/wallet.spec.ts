import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError } from './errors';
import { Money } from './money';
import { Wallet } from './wallet';

const BRL = (amount: string) => Money.create({ amount, currency: 'BRL' });

describe('Wallet', () => {
  test('open starts at version 1 with the initial balance', () => {
    const { wallet, opening } = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      initialBalance: BRL('50.00'),
      openedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(wallet.snapshot.version).toBe(1);
    expect(wallet.snapshot.balance.amount).toBe('50.00');
    expect(opening!.props.direction).toBe('CREDIT');
    expect(opening!.props.balanceAfter.amount).toBe('50.00');
  });

  test('successful debit: 100 - 80 -> 20, version increments by 1', () => {
    const { wallet: opened } = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      initialBalance: BRL('100.00'),
      openedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const { wallet, entry } = opened.debit(
      BRL('80.00'),
      'tx-1',
      new Date('2026-01-01T00:01:00Z'),
    );
    expect(wallet.snapshot.balance.amount).toBe('20.00');
    expect(wallet.snapshot.version).toBe(opened.snapshot.version + 1);
    expect(entry.props.direction).toBe('DEBIT');
    expect(entry.props.balanceAfter.amount).toBe('20.00');
  });

  test('insufficient funds rejects and leaves the wallet untouched', () => {
    const { wallet: opened } = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      initialBalance: BRL('50.00'),
      openedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const before = opened.snapshot.balance.amount;
    expect(() =>
      opened.debit(BRL('100.00'), 'tx-1', new Date()),
    ).toThrow(InsufficientFundsError);
    expect(opened.snapshot.balance.amount).toBe(before);
    expect(opened.snapshot.version).toBe(1);
  });

  test('credit: 20 + 80 -> 100, version increments by 1', () => {
    const { wallet: opened } = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      initialBalance: BRL('20.00'),
      openedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const { wallet } = opened.credit(BRL('80.00'), 'tx-1', new Date());
    expect(wallet.snapshot.balance.amount).toBe('100.00');
    expect(wallet.snapshot.version).toBe(opened.snapshot.version + 1);
  });

  test('mismatched currency on debit/credit throws CurrencyMismatchError', () => {
    const { wallet: opened } = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      initialBalance: BRL('10.00'),
      openedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(() => opened.debit(BRL('1.00'), 'tx-1', new Date())).not.toThrow();
    const usd = Money.create({ amount: '1.00', currency: 'USD' });
    expect(() => opened.debit(usd, 'tx-1', new Date())).toThrow(
      CurrencyMismatchError,
    );
  });

  test('rehydrate trusts persisted state without re-running invariants', () => {
    const w = Wallet.rehydrate({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      balance: BRL('0.00'),
      version: 42,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    expect(w.snapshot.version).toBe(42);
    expect(w.snapshot.balance.amount).toBe('0.00');
  });

  test('wallet is frozen — no mutation', () => {
    const { wallet } = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      initialBalance: BRL('10.00'),
      openedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(Object.isFrozen(wallet)).toBe(true);
    expect(Object.isFrozen(wallet.snapshot)).toBe(true);
  });
});