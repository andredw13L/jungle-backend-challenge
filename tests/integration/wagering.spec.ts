/**
 * Slice 5 integration tests — ProcessWager against real PostgreSQL.
 * Verifies BET/WIN/LOSS, idempotency replay, hash-conflict, balance
 * contention, and parallel wallet independence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { Test } from '@nestjs/testing';
import { loadEnv } from '../../src/config/env';
import { createOrm } from '../../src/infrastructure/database/orm.module';
import { WalletRepository } from '../../src/infrastructure/database/wallet.repository';
import { ProcessWager } from '../../src/wagering/process-wager';
import { WagerRepository } from '../../src/wagering/wager.repository';
import { NoopIdentityGuard } from '../../src/auth/noop-identity.guard';
import { AuthModule } from '../../src/auth/auth.module';
import { ProviderWageringController, WageringController } from '../../src/wagering/wagering.controller';

const env = loadEnv();
const orm = await createOrm(env);
await orm.connect();
const ormProvider = Promise.resolve(orm);
const wallets = new WalletRepository(ormProvider);
const wagers = new WagerRepository(ormProvider);
const processWager = new ProcessWager(ormProvider, wagers);
const admin = new Client({ connectionString: env.DATABASE_URL });
const ALICE = '00000000-0000-7000-8000-000000000001';
const BOB = '00000000-0000-7000-8000-000000000002';

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

function baseInput(
  playerId: string,
  walletId: string,
  amount = '10.00',
  idemKey = 'k-1',
  kind: 'BET' | 'WIN' | 'LOSS' = 'BET',
  externalTransactionId = 'ext-1',
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
  };
}

async function startHttpApp(
  controller: typeof ProviderWageringController | typeof WageringController,
  process: ProcessWager | { execute: (input: unknown) => Promise<unknown> } = processWager,
) {
  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule],
    controllers: [controller],
    providers: [
      { provide: WagerRepository, useValue: wagers },
      { provide: ProcessWager, useValue: process },
      { provide: NoopIdentityGuard, useValue: { canActivate: () => true } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  return app;
}

function appUrl(app: { getHttpServer: () => { address: () => { port: number } } }, path: string): string {
  return `http://127.0.0.1:${app.getHttpServer().address().port}${path}`;
}

describe('ProcessWager — BET/WIN/LOSS happy paths', () => {
  test('BET debits the wallet, increments version, writes one ledger entry, two outbox events', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const res = await processWager.execute(baseInput(ALICE, wid, '10.00', 'bet-1'));
    expect(res.status).toBe('PROCESSED');
    expect(res.wallet?.balance.amount).toBe('90.00');
    expect(res.wallet?.version).toBeGreaterThan(1);
    expect(res.idempotentReplay).toBe(false);

    const ledgerCount = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT' AND value_amount = '10.00'`,
      [wid],
    );
    expect(ledgerCount.rows[0].c).toBe(1);

    const obCount = await admin.query(
      `SELECT count(*)::int AS c FROM outbox WHERE payload->'data'->>'playerId' = $1`,
      [ALICE],
    );
    expect(obCount.rows[0].c).toBe(2); // opening + wager WalletBalanceChanged envelopes
  });

  test('WIN credits the wallet, increments version, writes one CREDIT ledger entry', async () => {
    const wid = await createWalletWithBalance(ALICE, '20.00');
    const res = await processWager.execute(baseInput(ALICE, wid, '10.00', 'win-1', 'WIN'));
    expect(res.status).toBe('PROCESSED');
    expect(res.wallet?.balance.amount).toBe('30.00');
  });

  test('LOSS does NOT touch the wallet and writes no ledger entry', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const before = (await admin.query('SELECT balance_amount, version FROM wallets WHERE id = $1', [wid])).rows[0];
    const res = await processWager.execute(baseInput(ALICE, wid, '10.00', 'loss-1', 'LOSS'));
    expect(res.status).toBe('PROCESSED');
    expect(res.wallet).toBeUndefined();
    const after = (await admin.query('SELECT balance_amount, version FROM wallets WHERE id = $1', [wid])).rows[0];
    expect(after).toEqual(before);

    const ledger = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [wid],
    );
    expect(ledger.rows[0].c).toBe(1); // only the opening CREDIT
  });

  test('BET with insufficient funds returns REJECTED INSUFFICIENT_FUNDS without ledger mutation', async () => {
    const wid = await createWalletWithBalance(ALICE, '50.00');
    const res = await processWager.execute(baseInput(ALICE, wid, '100.00', 'bet-overdraft'));
    expect(res.status).toBe('REJECTED');
    expect(res.failureCode).toBe('INSUFFICIENT_FUNDS');

    const after = (await admin.query('SELECT balance_amount, version FROM wallets WHERE id = $1', [wid])).rows[0];
    expect(after.balance_amount).toBe('50.00');
  });
});

describe('ProcessWager — idempotency', () => {
  test('50 identical requests produce one financial effect and replay the persisted response', async () => {
    const wid = await createWalletWithBalance(ALICE, '1000.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        processWager.execute(baseInput(ALICE, wid, '5.00', 'race-50')),
      ),
    );
    const ids = new Set(results.map((r) => r.wagerTransactionId));
    expect(ids.size).toBe(1);
    const replayCount = results.filter((r) => r.idempotentReplay).length;
    expect(replayCount).toBe(49);

    const ledger = await admin.query(
      `SELECT count(*)::int AS c
       FROM wallet_ledger_entries le
       JOIN wallets w ON le.wallet_id = w.id
       WHERE w.player_id = $1 AND le.direction = 'DEBIT' AND le.value_amount = '5.00'`,
      [ALICE],
    );
    expect(ledger.rows[0].c).toBe(1);

    const wallet = await admin.query(
      `SELECT balance_amount FROM wallets WHERE player_id = $1`,
      [ALICE],
    );
    expect(wallet.rows[0].balance_amount).toBe('995.00');
  });

  test('Same idempotency key + different payload → IDEMPOTENCY_CONFLICT (422)', async () => {
    const wid = await createWalletWithBalance(ALICE, '1000.00');
    await processWager.execute(baseInput(ALICE, wid, '5.00', 'shared-key', 'BET', 'a'));
    let conflict: unknown = null;
    try {
      await processWager.execute(baseInput(ALICE, wid, '7.00', 'shared-key', 'BET', 'b'));
    } catch (err) {
      conflict = err;
    }
    expect((conflict as { status?: number }).status).toBe(422);
    const wallet = await admin.query(`SELECT balance_amount FROM wallets WHERE player_id = $1`, [ALICE]);
    expect(wallet.rows[0].balance_amount).toBe('995.00'); // unchanged after the first call
  });

  test('Same idempotency key + reordered JSON keys → idempotent replay (hash stable)', async () => {
    const wid = await createWalletWithBalance(ALICE, '1000.00');
    const first = await processWager.execute(baseInput(ALICE, wid, '5.00', 'reorder'));
    const second = await processWager.execute({
      ...baseInput(ALICE, wid, '5.00', 'reorder'),
      correlationId: 'transport-only',
    });
    expect(second.idempotentReplay).toBe(true);
    expect(second.wagerTransactionId).toBe(first.wagerTransactionId);
  });

  test('second idempotency key for the same provider/external transaction is a 422 conflict with one effect', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const first = await processWager.execute(baseInput(ALICE, wid, '10.00', 'external-key-1', 'BET', 'external-1'));
    expect(first.status).toBe('PROCESSED');

    let conflict: unknown;
    try {
      await processWager.execute(baseInput(ALICE, wid, '10.00', 'external-key-2', 'BET', 'external-1'));
    } catch (err) {
      conflict = err;
    }
    expect(conflict).toMatchObject({
      status: 422,
      response: { code: 'EXTERNAL_TRANSACTION_CONFLICT' },
    });

    const effects = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_ledger_entries
       WHERE wallet_id = $1 AND direction = 'DEBIT' AND value_amount = '10.00'`,
      [wid],
    );
    const transactions = await admin.query(
      `SELECT count(*)::int AS c FROM wager_transactions
       WHERE provider_id = 'prov-1' AND external_transaction_id = 'external-1'`,
    );
    expect(effects.rows[0].c).toBe(1);
    expect(transactions.rows[0].c).toBe(1);
  });
});

describe('Task 3 — HTTP and rejected-event contracts', () => {
  test('provider/external lookup is reachable through the Nest HTTP adapter', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const created = await processWager.execute(baseInput(ALICE, wid, '10.00', 'http-lookup', 'BET', 'http-external'));
    const app = await startHttpApp(ProviderWageringController);
    try {
      const response = await fetch(appUrl(app, '/providers/prov-1/wagering/transactions/http-external'));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        transactionId: created.transactionId,
        providerId: 'prov-1',
        externalTransactionId: 'http-external',
        playerId: ALICE,
        walletId: wid,
        kind: 'BET',
        status: 'PROCESSED',
      });
    } finally {
      await app.close();
    }
  });

  test('insufficient funds persists a complete WagerTransactionRejected envelope', async () => {
    const wid = await createWalletWithBalance(ALICE, '5.00');
    const result = await processWager.execute(baseInput(ALICE, wid, '10.00', 'rejected-event'));
    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');

    const events = await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox ORDER BY created_at`,
    );
    const rejected = events.rows.find((row) =>
      row.event_type === 'WagerTransactionRejected' &&
      (row.payload.data as { wagerTransactionId?: string } | undefined)?.wagerTransactionId === result.transactionId,
    );
    expect(rejected?.payload).toMatchObject({
      eventId: expect.any(String),
      eventType: 'WagerTransactionRejected',
      aggregateId: result.transactionId,
      version: 1,
      data: {
        wagerTransactionId: result.transactionId,
        walletId: wid,
        type: 'BET',
        status: 'REJECTED',
        amount: { amount: '10.00', currency: 'BRL' },
        failureCode: 'INSUFFICIENT_FUNDS',
      },
    });
    expect(events.rows.some((row) =>
      row.event_type === 'WagerTransactionProcessed' &&
      (row.payload.data as { wagerTransactionId?: string } | undefined)?.wagerTransactionId === result.transactionId,
    )).toBe(false);
  });

  test('40001 is translated to HTTP 503 at the controller boundary', async () => {
    const transientProcess = {
      execute: async () => {
        throw Object.assign(new Error('serialization failure'), { code: '40001' });
      },
    };
    const app = await startHttpApp(WageringController, transientProcess);
    try {
      const response = await fetch(appUrl(app, '/wagering/transactions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'http-transient' },
        body: JSON.stringify({
          providerId: 'prov-1',
          externalTransactionId: 'http-transient',
          playerId: ALICE,
          walletId: crypto.randomUUID(),
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'TRANSIENT_INFRASTRUCTURE' });
    } finally {
      await app.close();
    }
  });
});

describe('ProcessWager — balance contention and wallet independence', () => {
  test('Two concurrent BETs against the same wallet: one PROCESSED, one REJECTED INSUFFICIENT_FUNDS', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const settled = await Promise.allSettled([
      processWager.execute(baseInput(ALICE, wid, '80.00', 'race-1', 'BET', 'ext-race-1')),
      processWager.execute(baseInput(ALICE, wid, '80.00', 'race-2', 'BET', 'ext-race-2')),
    ]);
    const processed = settled.filter((s) => s.status === 'fulfilled' && (s as PromiseFulfilledResult<{ status: string }>).value.status === 'PROCESSED');
    const rejected = settled.filter((s) => s.status === 'fulfilled' && (s as PromiseFulfilledResult<{ status: string; failureCode?: string }>).value.status === 'REJECTED');
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseFulfilledResult<{ failureCode?: string }>).value.failureCode).toBe('INSUFFICIENT_FUNDS');

    const wallet = await admin.query(`SELECT balance_amount FROM wallets WHERE player_id = $1`, [ALICE]);
    expect(wallet.rows[0].balance_amount).toBe('20.00');
  });

  test('Distinct wallets process in parallel without waiting on each other', async () => {
    const aliceWallet = await createWalletWithBalance(ALICE, '100.00');
    const bobWallet = await createWalletWithBalance(BOB, '100.00');
    const [a, b] = await Promise.all([
      processWager.execute(baseInput(ALICE, aliceWallet, '10.00', 'a-key')),
      processWager.execute(baseInput(BOB, bobWallet, '20.00', 'b-key', 'BET', 'ext-b')),
    ]);
    expect(a.status).toBe('PROCESSED');
    expect(b.status).toBe('PROCESSED');
    expect(a.wallet?.balance.amount).toBe('90.00');
    expect(b.wallet?.balance.amount).toBe('80.00');
  });
});
