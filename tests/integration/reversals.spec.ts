/**
 * Slice 6 integration tests — REFUND / ROLLBACK / PENDING_REFERENCE worker.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../src/auth/auth.module';
import { loadEnv } from '../../src/config/env';
import { createOrm } from '../../src/infrastructure/database/orm.module';
import { NoopIdentityGuard } from '../../src/auth/noop-identity.guard';
import { WalletRepository } from '../../src/infrastructure/database/wallet.repository';
import { ProcessWager } from '../../src/wagering/process-wager';
import { PendingReferenceWorker } from '../../src/wagering/pending-reference.worker';
import { WagerRepository } from '../../src/wagering/wager.repository';
import { WageringController } from '../../src/wagering/wagering.controller';

const env = loadEnv();
const orm = await createOrm(env);
await orm.connect();
const ormProvider = Promise.resolve(orm);
const wallets = new WalletRepository(ormProvider);
const wagers = new WagerRepository(ormProvider);
const processWager = new ProcessWager(ormProvider, wagers);
const worker = new PendingReferenceWorker(ormProvider, processWager);
const admin = new Client({ connectionString: env.DATABASE_URL });

async function truncateAll(): Promise<void> {
  await admin.query('TRUNCATE outbox, wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE');
}

async function createWalletWithBalance(playerId: string, amount: string): Promise<string> {
  const created = await wallets.createAtomic({
    id: crypto.randomUUID(),
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  return created.wallet.id;
}

beforeAll(async () => {
  await admin.connect();
  await truncateAll();
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await admin.end().catch(() => undefined);
  await orm.close(true);
});

function wagerInput(
  playerId: string,
  walletId: string,
  kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK',
  amount: string,
  idemKey: string,
  externalTransactionId: string,
  referenceExternalTransactionId?: string,
) {
  return {
    idempotencyKey: idemKey,
    kind,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    money: { amount, currency: 'BRL' as const },
    externalTransactionId,
    providerId: 'prov-1',
    ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
  };
}

async function placeBet(playerId: string, walletId: string, amount: string, idemKey: string) {
  const res = await processWager.execute(wagerInput(
    playerId,
    walletId,
    'BET',
    amount,
    idemKey,
    `ext-${idemKey}`,
  ));
  if (res.status !== 'PROCESSED') throw new Error(`bet ${idemKey} did not process: ${res.failureCode}`);
  return res.wagerTransactionId;
}

describe('REFUND / ROLLBACK — in-order reversals', () => {
  test('REFUND of PROCESSED BET credits the wallet', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    await placeBet('alice', wid, '30.00', 'bet-1');

    const res = await processWager.execute(wagerInput(
      'alice', wid, 'REFUND', '30.00', 'refund-1', 'ext-refund-1', 'ext-bet-1',
    ));
    expect(res.status).toBe('PROCESSED');
    expect(res.wallet?.balance.amount).toBe('50.00');
    // opening(1) → bet debit(2) → refund credit(3)
    expect(res.wallet?.version).toBe(3);

    const ledger = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_ledger_entries
       WHERE direction = 'CREDIT' AND value_amount = '30.00'`,
    );
    // The opening was 50.00 CREDIT; the refund is the only 30.00 CREDIT.
    expect(ledger.rows[0].c).toBe(1);
  });

  test('ROLLBACK of PROCESSED WIN debits the wallet', async () => {
    const wid = await createWalletWithBalance('alice', '20.00');
    await processWager.execute(wagerInput(
      'alice', wid, 'WIN', '15.00', 'win-1', 'ext-win-1',
    ));

    const res = await processWager.execute(wagerInput(
      'alice', wid, 'ROLLBACK', '15.00', 'rollback-1', 'ext-rollback-1', 'ext-win-1',
    ));
    expect(res.status).toBe('PROCESSED');
    expect(res.wallet?.balance.amount).toBe('20.00'); // back to original
  });

  test('ROLLBACK of PROCESSED BET credits the wallet', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    await placeBet('alice', wid, '15.00', 'bet-rollback-bet');

    const res = await processWager.execute(wagerInput(
      'alice', wid, 'ROLLBACK', '15.00', 'rollback-bet', 'ext-rollback-bet', 'ext-bet-rollback-bet',
    ));
    expect(res.status).toBe('PROCESSED');
    expect(res.wallet?.balance).toEqual({ amount: '50.00', currency: 'BRL' });
  });

  test('ROLLBACK of PROCESSED REFUND debits the wallet exactly', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    await placeBet('alice', wid, '15.00', 'bet-rollback-refund');
    const refund = await processWager.execute(wagerInput(
      'alice', wid, 'REFUND', '15.00', 'refund-before-rollback', 'ext-refund-before-rollback', 'ext-bet-rollback-refund',
    ));
    expect(refund.status).toBe('PROCESSED');

    const res = await processWager.execute(wagerInput(
      'alice', wid, 'ROLLBACK', '15.00', 'rollback-refund', 'ext-rollback-refund', 'ext-refund-before-rollback',
    ));
    expect(res.status).toBe('PROCESSED');
    expect(res.wallet?.balance).toEqual({ amount: '35.00', currency: 'BRL' });
    const ledger = await admin.query(
      `SELECT direction, value_amount FROM wallet_ledger_entries
       WHERE wallet_id = $1 ORDER BY created_at, id`, [wid],
    );
    expect(ledger.rows.slice(-2)).toEqual([
      { direction: 'CREDIT', value_amount: '15.00' },
      { direction: 'DEBIT', value_amount: '15.00' },
    ]);
  });

  test('reference with mismatched amount → REJECTED REFERENCE_MISMATCH', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    await placeBet('alice', wid, '10.00', 'bet-mm');

    const res = await processWager.execute(wagerInput(
      'alice', wid, 'REFUND', '99.00', 'refund-mm', 'ext-refund-mm', 'ext-bet-mm',
    ));
    expect(res.status).toBe('REJECTED');
    expect(res.failureCode).toBe('REFERENCE_MISMATCH');
  });

  test('reference scope/type/currency mismatches are persisted rejected without a ledger effect', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    await placeBet('alice', wid, '10.00', 'bet-scope');

    const playerMismatch = await processWager.execute({
      ...wagerInput('bob', wid, 'REFUND', '10.00', 'refund-player', 'ext-refund-player', 'ext-bet-scope'),
    });
    const roundMismatch = await processWager.execute({
      ...wagerInput('alice', wid, 'REFUND', '10.00', 'refund-round', 'ext-refund-round', 'ext-bet-scope'),
      roundId: 'other-round',
    });
    const currencyMismatch = await processWager.execute({
      ...wagerInput('alice', wid, 'REFUND', '10.00', 'refund-currency', 'ext-refund-currency', 'ext-bet-scope'),
      money: { amount: '10.00', currency: 'USD' },
    });

    for (const result of [playerMismatch, roundMismatch, currencyMismatch]) {
      expect(result.status).toBe('REJECTED');
      expect(result.failureCode).toBe('REFERENCE_MISMATCH');
    }
    const effects = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_ledger_entries
       WHERE wallet_id = $1 AND transaction_id <> (SELECT id FROM wager_transactions WHERE external_transaction_id = 'ext-bet-scope')`, [wid],
    );
    expect(effects.rows[0].c).toBe(1); // only the opening CREDIT remains
  });

  test('REFUND rejects a PROCESSED WIN as a prohibited reference type', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    await processWager.execute(wagerInput('alice', wid, 'WIN', '10.00', 'win-refund-type', 'ext-win-refund-type'));

    const res = await processWager.execute(wagerInput(
      'alice', wid, 'REFUND', '10.00', 'refund-win-type', 'ext-refund-win-type', 'ext-win-refund-type',
    ));
    expect(res.status).toBe('REJECTED');
    expect(res.failureCode).toBe('REFERENCE_MISMATCH');
  });

  test('reversal would overdraw → REJECTED REVERSAL_WOULD_OVERDRAW', async () => {
    const wid = await createWalletWithBalance('alice', '10.00');
    // Roll back a WIN bigger than the wallet holds.
    await placeBet('alice', wid, '5.00', 'bet-od'); // 10 → 5
    await processWager.execute(wagerInput(
      'alice', wid, 'WIN', '50.00', 'win-od', 'ext-win-od',
    ));
    // Now ROLLBACK the 50 WIN. Wallet has 55, ROLLBACK would debit 50 → 5.
    // Add a NEW debit so wallet is exactly 5: the ROLLBACK must overdraw.

    const drain = await processWager.execute(wagerInput(
      'alice', wid, 'BET', '50.00', 'bet-drain', 'ext-bet-drain',
    ));
    expect(drain.status).toBe('PROCESSED');

    const res = await processWager.execute(wagerInput(
      'alice', wid, 'ROLLBACK', '50.00', 'rollback-od', 'ext-rollback-od', 'ext-win-od',
    ));
    expect(res.status).toBe('REJECTED');
    expect(res.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
  });

  test('a new idempotency retry after overdraw is re-evaluated as the same stable rejection', async () => {
    const wid = await createWalletWithBalance('alice', '10.00');
    await placeBet('alice', wid, '5.00', 'bet-retry-overdraw');
    await processWager.execute(wagerInput('alice', wid, 'WIN', '50.00', 'win-retry-overdraw', 'ext-win-retry-overdraw'));
    await processWager.execute(wagerInput('alice', wid, 'BET', '50.00', 'drain-retry-overdraw', 'ext-drain-retry-overdraw'));

    const first = await processWager.execute(wagerInput(
      'alice', wid, 'ROLLBACK', '50.00', 'rollback-overdraw-1', 'ext-rollback-overdraw-1', 'ext-win-retry-overdraw',
    ));
    const retry = await processWager.execute(wagerInput(
      'alice', wid, 'ROLLBACK', '50.00', 'rollback-overdraw-2', 'ext-rollback-overdraw-2', 'ext-win-retry-overdraw',
    ));
    expect(first).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW' });
    expect(retry).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW' });
    const rows = await admin.query(
      `SELECT count(*)::int AS c FROM wager_transactions
       WHERE type = 'ROLLBACK' AND failure_code = 'REVERSAL_WOULD_OVERDRAW'`,
    );
    expect(rows.rows[0].c).toBe(2);
  });

  test('duplicate reversal of same reference+type → second one translated to REJECTED', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    await placeBet('alice', wid, '20.00', 'bet-dup');

    const first = await processWager.execute(wagerInput(
      'alice', wid, 'REFUND', '20.00', 'refund-dup-1', 'ext-refund-dup-1', 'ext-bet-dup',
    ));
    expect(first.status).toBe('PROCESSED');

    // The second reversal uses a different idempotency key but the same
    // public (provider, referenceExternalTransactionId, type).
    const second = await processWager.execute(wagerInput(
      'alice', wid, 'REFUND', '20.00', 'refund-dup-2', 'ext-refund-dup-2', 'ext-bet-dup',
    ));
    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  });

  test('concurrent duplicate reversals produce one credit and one stable rejection', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    await placeBet('alice', wid, '20.00', 'bet-concurrent-dup');

    const results = await Promise.all([
      processWager.execute(wagerInput('alice', wid, 'REFUND', '20.00', 'refund-concurrent-1', 'ext-refund-concurrent-1', 'ext-bet-concurrent-dup')),
      processWager.execute(wagerInput('alice', wid, 'REFUND', '20.00', 'refund-concurrent-2', 'ext-refund-concurrent-2', 'ext-bet-concurrent-dup')),
    ]);
    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(1);
    const effects = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_ledger_entries
       WHERE wallet_id = $1 AND direction = 'CREDIT' AND value_amount = '20.00'`, [wid],
    );
    expect(effects.rows[0].c).toBe(1);
  });

  test('an external reference owned by another provider is rejected immediately', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    const bet = await processWager.execute({
      ...wagerInput('alice', wid, 'BET', '10.00', 'provider-a-bet', 'shared-ref'),
      providerId: 'prov-a',
    });
    expect(bet.status).toBe('PROCESSED');

    const reversal = await processWager.execute({
      ...wagerInput('alice', wid, 'REFUND', '10.00', 'provider-b-refund', 'provider-b-refund-ext', 'shared-ref'),
      providerId: 'prov-b',
    });
    expect(reversal).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
    const row = (await admin.query(
      `SELECT status, failure_code FROM wager_transactions WHERE id = $1`, [reversal.transactionId],
    )).rows[0];
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_MISMATCH' });
  });

  test('provider mismatch after a valid reversal is still REFERENCE_MISMATCH', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    await processWager.execute({
      ...wagerInput('alice', wid, 'BET', '10.00', 'provider-a-bet-after-refund', 'provider-shared-ref'),
      providerId: 'prov-a',
    });
    const first = await processWager.execute({
      ...wagerInput('alice', wid, 'REFUND', '10.00', 'provider-a-refund', 'provider-a-refund-ext', 'provider-shared-ref'),
      providerId: 'prov-a',
    });
    expect(first.status).toBe('PROCESSED');

    const second = await processWager.execute({
      ...wagerInput('alice', wid, 'REFUND', '10.00', 'provider-b-refund', 'provider-b-refund-ext', 'provider-shared-ref'),
      providerId: 'prov-b',
    });
    expect(second).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
  });

  test('same reference with a different Wallet is REFERENCE_MISMATCH without a Wallet effect', async () => {
    const sourceWallet = await createWalletWithBalance('alice', '50.00');
    const otherWallet = await createWalletWithBalance('bob', '70.00');
    await placeBet('alice', sourceWallet, '10.00', 'wallet-scope-bet');

    const result = await processWager.execute(wagerInput(
      'bob', otherWallet, 'REFUND', '10.00', 'wallet-scope-refund', 'wallet-scope-refund-ext', 'ext-wallet-scope-bet',
    ));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
    const wallet = (await admin.query(
      `SELECT balance_amount, version FROM wallets WHERE id = $1`, [otherWallet],
    )).rows[0];
    expect(wallet).toEqual({ balance_amount: '70.00', version: 1 });
    const ledger = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = $1`, [otherWallet],
    );
    expect(ledger.rows[0].c).toBe(1); // opening CREDIT only
  });

  test('HTTP refund with an unavailable external reference returns 202 and PENDING through Nest', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule],
      controllers: [WageringController],
      providers: [
        { provide: WagerRepository, useValue: wagers },
        { provide: ProcessWager, useValue: processWager },
        { provide: NoopIdentityGuard, useValue: { canActivate: () => true } },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    try {
      const address = app.getHttpServer().address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'http-pending-refund' },
        body: JSON.stringify({
          providerId: 'prov-1',
          externalTransactionId: 'http-refund-ext',
          playerId: '00000000-0000-7000-8000-000000000001',
          walletId: wid,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'REFUND',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: 'http-bet-not-yet-available',
        }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        status: 'PENDING',
        referenceExternalTransactionId: 'http-bet-not-yet-available',
      });
    } finally {
      await app.close();
    }
  });
});

describe('PENDING_REFERENCE — out-of-order reversals', () => {
  test('REFUND arriving before BET → PENDING_REFERENCE (status); worker later resolves once BET is PROCESSED', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');

    const pending = await processWager.execute(wagerInput(
      'alice', wid, 'REFUND', '20.00', 'refund-before-bet', 'ext-refund-before-bet', 'ext-bet-after-refund',
    ));
    expect(pending.status).toBe('PENDING');
    const pendingId = pending.transactionId;
    const pendingRow = (await admin.query(
      `SELECT status, reference_external_transaction_id, reference, reference_attempts
       FROM wager_transactions WHERE id = $1`, [pendingId],
    )).rows[0];
    expect(pendingRow).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_external_transaction_id: 'ext-bet-after-refund',
      reference: null,
      reference_attempts: 1,
    });
    const pendingEvents = await admin.query(
      `SELECT event_type FROM outbox WHERE payload->'data'->>'wagerTransactionId' = $1`, [pendingId],
    );
    expect(pendingEvents.rows).toEqual([{ event_type: 'WagerTransactionPendingReference' }]);

    const before = (
      await admin.query(`SELECT balance_amount, version FROM wallets WHERE player_id = 'alice'`)
    ).rows[0];
    // Place the BET AFTER the refund was queued — this is the out-of-order case.
    await placeBet('alice', wid, '20.00', 'bet-after-refund');
    await admin.query(`UPDATE wager_transactions SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [pendingId]);

    const out = await worker.processBatch({ baseSeconds: 0, maxSeconds: 0 });
    expect(out.resolved).toBe(1);

    const resolved = (
      await admin.query(`SELECT status, failure_code FROM wager_transactions WHERE id = $1`, [pendingId])
    ).rows[0];
    expect(resolved.status).toBe('PROCESSED');
    expect((await admin.query(`SELECT reference FROM wager_transactions WHERE id = $1`, [pendingId])).rows[0].reference)
      .not.toBeNull();

    const after = (
      await admin.query(`SELECT balance_amount, version FROM wallets WHERE player_id = 'alice'`)
    ).rows[0];
    // wallet: open 50 - bet 20 + refund 20 = 50
    expect(after.balance_amount).toBe(before.balance_amount);
    expect(Number(after.version)).toBeGreaterThan(Number(before.version));
  });

  test('worker exhausts attempts → REJECTED with REFERENCE_NOT_FOUND', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    // Reference id that does not exist — the worker cannot resolve it,
    // exhausts attempts, and rejects.
    const pending = await processWager.execute(wagerInput(
      'alice', wid, 'REFUND', '10.00', 'idem-exhaust', 'ext-exhaust', 'missing-bet-external',
    ));
    expect(pending.status).toBe('PENDING');
    const pendingId = pending.transactionId;
    await admin.query(
      `UPDATE wager_transactions
       SET next_retry_at = now() - interval '1 minute', reference_attempts = 8
       WHERE id = $1`, [pendingId],
    );

    const out = await worker.processBatch({ maxAttempts: 8 });
    expect(out.rejected).toBe(1);

    const row = (
      await admin.query(`SELECT status, failure_code FROM wager_transactions WHERE id = $1`, [pendingId])
    ).rows[0];
    expect(row.status).toBe('REJECTED');
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
    const rejectedEvents = await admin.query(
      `SELECT count(*)::int AS c FROM outbox
       WHERE event_type = 'WagerTransactionRejected'
         AND payload->'data'->>'wagerTransactionId' = $1`, [pendingId],
    );
    expect(rejectedEvents.rows[0].c).toBe(1);
  });

  test('a fresh worker/ORM resolves pending references after restart', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    const pending = await processWager.execute(wagerInput(
      'alice', wid, 'ROLLBACK', '10.00', 'restart-pending', 'ext-restart-rollback', 'ext-restart-win',
    ));
    expect(pending.status).toBe('PENDING');
    await processWager.execute(wagerInput('alice', wid, 'WIN', '10.00', 'restart-win', 'ext-restart-win'));
    await admin.query(`UPDATE wager_transactions SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [pending.transactionId]);

    const freshOrm = await createOrm(env);
    await freshOrm.connect();
    try {
      const freshProcess = new ProcessWager(Promise.resolve(freshOrm), new WagerRepository(Promise.resolve(freshOrm)));
      const freshWorker = new PendingReferenceWorker(Promise.resolve(freshOrm), freshProcess);
      const out = await freshWorker.processBatch({ baseSeconds: 0, maxSeconds: 0 });
      expect(out.resolved).toBe(1);
    } finally {
      await freshOrm.close(true);
    }
    const row = (await admin.query(`SELECT status FROM wager_transactions WHERE id = $1`, [pending.transactionId])).rows[0];
    expect(row.status).toBe('PROCESSED');
  });

  test('two workers claim different due rows without duplicate financial effects', async () => {
    const wid = await createWalletWithBalance('alice', '50.00');
    const first = await processWager.execute(wagerInput('alice', wid, 'REFUND', '5.00', 'worker-pending-1', 'ext-worker-refund-1', 'ext-worker-bet-1'));
    const second = await processWager.execute(wagerInput('alice', wid, 'REFUND', '7.00', 'worker-pending-2', 'ext-worker-refund-2', 'ext-worker-bet-2'));
    await processWager.execute(wagerInput('alice', wid, 'BET', '5.00', 'worker-bet-1', 'ext-worker-bet-1'));
    await processWager.execute(wagerInput('alice', wid, 'BET', '7.00', 'worker-bet-2', 'ext-worker-bet-2'));
    await admin.query(`UPDATE wager_transactions SET next_retry_at = now() - interval '1 second' WHERE id IN ($1, $2)`, [first.transactionId, second.transactionId]);

    const otherProcess = new ProcessWager(ormProvider, new WagerRepository(ormProvider));
    const otherWorker = new PendingReferenceWorker(ormProvider, otherProcess);
    const outcomes = await Promise.all([
      worker.processBatch({ baseSeconds: 0, maxSeconds: 0, batchSize: 1 }),
      otherWorker.processBatch({ baseSeconds: 0, maxSeconds: 0, batchSize: 1 }),
    ]);
    expect(outcomes.reduce((sum, out) => sum + out.resolved, 0)).toBe(2);
    const wallet = (await admin.query(`SELECT balance_amount FROM wallets WHERE id = $1`, [wid])).rows[0];
    expect(wallet.balance_amount).toBe('50.00');
  });
});
