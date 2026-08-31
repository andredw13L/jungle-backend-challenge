import { describe, expect, test } from 'bun:test';
import {
  InvalidWagerError,
  InvalidWagerTransitionError,
} from './errors';
import { Money } from './money';
import { WagerTransaction } from './wager-transaction';

const BRL = (amount: string) => Money.create({ amount, currency: 'BRL' });
const at = (iso: string) => new Date(iso);

describe('WagerTransaction', () => {
  const baseCreate = {
    id: 'tx-1',
    walletId: 'wallet-1',
    providerId: 'prov-1',
    externalTransactionId: 'ext-1',
    amount: BRL('10.00'),
    payloadHash: 'hash',
    createdAt: at('2026-01-01T00:00:00Z'),
  };

  test('create starts in PENDING with the provided fields', () => {
    const tx = WagerTransaction.create({
      ...baseCreate,
      type: 'BET',
    });
    expect(tx.snapshot.status).toBe('PENDING');
    expect(tx.snapshot.type).toBe('BET');
    expect(tx.snapshot.amount.amount).toBe('10.00');
  });

  test('create rejects OPENING from external sources', () => {
    expect(() =>
      WagerTransaction.create({ ...baseCreate, type: 'OPENING' }),
    ).toThrow(InvalidWagerError);
  });

  test('REFUND / ROLLBACK require a reference', () => {
    expect(() =>
      WagerTransaction.create({ ...baseCreate, type: 'REFUND' }),
    ).toThrow(InvalidWagerError);
    expect(() =>
      WagerTransaction.create({ ...baseCreate, type: 'ROLLBACK' }),
    ).toThrow(InvalidWagerError);
    expect(() =>
      WagerTransaction.create({
        ...baseCreate,
        type: 'REFUND',
        reference: 'tx-99',
      }),
    ).not.toThrow();
  });

  test('terminal states cannot transition', () => {
    const tx = WagerTransaction.create({ ...baseCreate, type: 'BET' });
    const processed = tx.markProcessed('{}', at('2026-01-01T00:01:00Z'));
    expect(processed.snapshot.status).toBe('PROCESSED');
    expect(() => processed.markProcessed('{}', at('2026-01-01T00:02:00Z'))).toThrow(
      InvalidWagerTransitionError,
    );
    expect(() =>
      processed.markRejected('INSUFFICIENT_FUNDS', '{}', at('2026-01-01T00:02:00Z')),
    ).toThrow(InvalidWagerTransitionError);
  });

  test('markRejected records a stable failure code and payload', () => {
    const tx = WagerTransaction.create({ ...baseCreate, type: 'BET' });
    const rejected = tx.markRejected('INSUFFICIENT_FUNDS', '{}', at('2026-01-01T00:01:00Z'));
    expect(rejected.snapshot.status).toBe('REJECTED');
    expect(rejected.snapshot.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('createOpening is internal-only and starts as PROCESSED', () => {
    const tx = WagerTransaction.createOpening({
      id: 'open-1',
      walletId: 'wallet-1',
      amount: BRL('100.00'),
      openedAt: at('2026-01-01T00:00:00Z'),
    });
    expect(tx.snapshot.type).toBe('OPENING');
    expect(tx.snapshot.status).toBe('PROCESSED');
  });

  test('rehydrate trusts persisted state', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-1',
      type: 'BET',
      status: 'PROCESSED',
      walletId: 'wallet-1',
      providerId: 'prov-1',
      externalTransactionId: 'ext-1',
      amount: BRL('10.00'),
      payloadHash: 'hash',
      responsePayload: '{}',
      referenceAttempts: 0,
      createdAt: at('2026-01-01T00:00:00Z'),
      processedAt: at('2026-01-01T00:01:00Z'),
    });
    expect(tx.snapshot.status).toBe('PROCESSED');
  });

  test('is frozen — no mutation', () => {
    const tx = WagerTransaction.create({ ...baseCreate, type: 'BET' });
    expect(Object.isFrozen(tx)).toBe(true);
    expect(Object.isFrozen(tx.snapshot)).toBe(true);
  });
});