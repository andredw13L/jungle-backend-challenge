import { describe, expect, test } from 'bun:test';
import { ProcessWager } from './process-wager';

describe('ProcessWager wallet lock metrics', () => {
  test('records PostgreSQL lock conflicts from the shared wallet path', async () => {
    let conflicts = 0;
    const em = {
      fork: () => em,
      transactional: async (work: (manager: never) => Promise<unknown>) => work(em as never),
    };
    const repo = {
      insertPending: async () => ({ id: 'tx-1' }),
      lockWallet: async () => { throw Object.assign(new Error('lock timeout'), { code: '55P03' }); },
    };
    const process = new (ProcessWager as unknown as new (...args: unknown[]) => ProcessWager)(
      Promise.resolve({ em }),
      repo,
      { recordWalletLockConflict: () => { conflicts += 1; } },
    );

    await expect(process.execute({
      idempotencyKey: 'key-1',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-1',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    })).rejects.toBeDefined();
    expect(conflicts).toBe(1);
  });
});
