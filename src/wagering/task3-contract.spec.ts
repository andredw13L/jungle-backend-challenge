import { describe, expect, test } from 'bun:test';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { SubmitWagerSchema } from './dto/submit-wager.dto';
import { ProcessWager } from './process-wager';
import { WageringController } from './wagering.controller';

describe('Task 3 wager contract', () => {
  test('accepts the README wager body and passes normalized business fields to ProcessWager', async () => {
    let received: unknown;
    const process = {
      execute: async (input: unknown) => {
        received = input;
        return {
          transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
          status: 'PROCESSED' as const,
          balance: { amount: '975.00', currency: 'BRL' },
          idempotentReplay: false,
        };
      },
    };
    const controller = new WageringController(
      process as never,
      { findByIdPublic: async () => null } as never,
    );

    const result = await controller.submit(
      {
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25', currency: 'BRL' },
      },
      'provider-a:transaction-123',
      'corr-1',
    );

    expect(received).toEqual({
      idempotencyKey: 'provider-a:transaction-123',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: 'corr-1',
    });
    expect(result).toEqual({
      transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  test('rejects legacy aliases and unknown fields at the HTTP boundary', async () => {
    const controller = new WageringController(
      { execute: async () => { throw new Error('must not execute'); } } as never,
      { findByIdPublic: async () => null } as never,
    );

    await expect(controller.submit(
      {
        type: 'BET',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        currency: 'BRL',
        amount: { amount: '25.00', currency: 'BRL' },
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
      },
      'key-1',
    )).rejects.toMatchObject({ response: { code: 'INVALID_PAYLOAD' } });

    await expect(controller.submit(
      {
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        unexpected: true,
      },
      'key-1',
    )).rejects.toMatchObject({ response: { code: 'INVALID_PAYLOAD' } });

    expect(SubmitWagerSchema.safeParse({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7e38-af88-e43f851a819d',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.0', currency: 'BRL' },
    }).success).toBe(true);
  });

  test('rejects an empty or oversized HTTP idempotency key before processing', async () => {
    let called = false;
    const controller = new WageringController(
      { execute: async () => { called = true; throw new Error('must not execute'); } } as never,
      { findByIdPublic: async () => null } as never,
    );
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    await expect(controller.submit(body, '')).rejects.toMatchObject({ response: { code: 'INVALID_PAYLOAD' } });
    await expect(controller.submit(body, 'x'.repeat(257))).rejects.toMatchObject({ response: { code: 'INVALID_PAYLOAD' } });
    expect(called).toBe(false);
  });

  test('records the transaction outcome for the HTTP adapter', async () => {
    const outcomes: string[] = [];
    const controller = new (WageringController as unknown as new (...args: unknown[]) => WageringController)(
      {
        execute: async () => ({
          transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
          status: 'PROCESSED' as const,
          idempotentReplay: false,
        }),
      },
      { findByIdPublic: async () => null },
      { recordInboxReceived: (outcome: string) => outcomes.push(outcome) },
    );

    await controller.submit({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    }, 'key-1');

    expect(outcomes).toEqual(['processed']);
  });

  test('serializes a typed event with aggregateId, version, and readonly data envelope', () => {
    const event = new WagerTransactionProcessed(
      'evt-1',
      new Date('2026-01-01T00:00:00.000Z'),
      'corr-1',
      {
        wagerTransactionId: 'tx-1',
        walletId: 'wallet-1',
        type: 'BET',
        status: 'PROCESSED',
        amount: { amount: '25.00', currency: 'BRL' },
      },
    );
    const json = event.toJSON();
    expect(json).toMatchObject({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'tx-1',
      version: 1,
      correlationId: 'corr-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      data: {
        wagerTransactionId: 'tx-1',
        amount: { amount: '25.00', currency: 'BRL' },
      },
    });
  });

  test('core rejects the pre-contract aliases before opening a transaction', async () => {
    const process = new ProcessWager(
      Promise.resolve({} as never),
      {} as never,
    );

    await expect(process.execute({
      idempotencyKey: 'legacy-key',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      type: 'BET',
      currency: 'BRL',
      amount: { amount: '25.00', currency: 'BRL' },
    } as never)).rejects.toMatchObject({ response: { code: 'INVALID_PAYLOAD' } });
  });
});
