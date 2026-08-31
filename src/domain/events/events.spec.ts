import { describe, expect, test } from 'bun:test';
import { Money } from '../money';
import { WalletBalanceChanged } from './wallet-balance-changed';
import { WagerTransactionProcessed } from './wager-transaction-processed';
import { WagerTransactionPendingReference } from './wager-transaction-pending-reference';

describe('IntegrationEvent envelope', () => {
  test('WalletBalanceChanged serialises with ISO-8601 date and decimal Money', () => {
    const ev = new WalletBalanceChanged(
      'evt-1',
      new Date('2026-01-01T00:00:00.000Z'),
      'corr-1',
      {
        walletId: 'w-1',
        playerId: 'p-1',
        currency: 'BRL',
        walletVersion: 2,
        direction: 'DEBIT',
        value: { amount: '80.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '20.00', currency: 'BRL' },
        transactionId: 'tx-1',
      },
    );
    const json = ev.toJSON();
    expect(json['eventId']).toBe('evt-1');
    expect(json['eventType']).toBe('WalletBalanceChanged');
    expect(json['schemaVersion']).toBe(1);
    expect(json['occurredAt']).toBe('2026-01-01T00:00:00.000Z');
    expect(json['correlationId']).toBe('corr-1');
    expect(json['direction']).toBe('DEBIT');
    expect((json['balanceAfter'] as { amount: string }).amount).toBe('20.00');
  });

  test('WagerTransactionProcessed serialises the failure code on REJECTED', () => {
    const ev = new WagerTransactionProcessed(
      'evt-2',
      new Date('2026-01-01T00:00:00.000Z'),
      undefined,
      {
        wagerTransactionId: 'tx-2',
        walletId: 'w-1',
        type: 'BET',
        status: 'REJECTED',
        amount: Money.create({ amount: '50.00', currency: 'BRL' }).toJSON(),
        failureCode: 'INSUFFICIENT_FUNDS',
      },
    );
    const json = ev.toJSON();
    expect(json['eventType']).toBe('WagerTransactionProcessed');
    expect(json['schemaVersion']).toBe(1);
    expect(json['failureCode']).toBe('INSUFFICIENT_FUNDS');
    expect(json['correlationId']).toBeUndefined();
  });

  test('pending reference uses its own typed event and preserves the public reference', () => {
    const ev = new WagerTransactionPendingReference(
      'evt-pending',
      new Date('2026-01-01T00:00:00.000Z'),
      undefined,
      {
        wagerTransactionId: 'tx-pending',
        walletId: 'w-1',
        type: 'REFUND',
        status: 'PENDING_REFERENCE',
        amount: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-external-1',
      },
    );
    expect(ev.toJSON()).toMatchObject({
      eventType: 'WagerTransactionPendingReference',
      aggregateId: 'tx-pending',
      data: {
        status: 'PENDING_REFERENCE',
        referenceExternalTransactionId: 'bet-external-1',
      },
    });
  });

  test('envelope is frozen — no mutation after construction', () => {
    const ev = new WalletBalanceChanged(
      'evt-3',
      new Date(),
      undefined,
      {
        walletId: 'w',
        playerId: 'p',
        currency: 'BRL',
        walletVersion: 1,
        direction: 'CREDIT',
        value: { amount: '1.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '1.00', currency: 'BRL' },
        transactionId: 'tx',
      },
    );
    expect(Object.isFrozen(ev)).toBe(true);
  });
});
