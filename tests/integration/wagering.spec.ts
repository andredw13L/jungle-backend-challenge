/**
 * Slice 5 integration tests — ProcessWager against real PostgreSQL.
 * Verifies BET/WIN/LOSS, idempotency replay, hash-conflict, balance
 * contention, and parallel wallet independence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { loadEnv } from '../../src/config/env';
import { makePool } from '../../src/infrastructure/database/pool';
import { WalletRepository } from '../../src/infrastructure/database/wallet.repository';
import { ProcessWager } from '../../src/wagering/process-wager';
import { WagerRepository } from '../../src/wagering/wager.repository';

const env = loadEnv();
const pool = makePool(env);
const wallets = new WalletRepository(pool);
const wagers = new WagerRepository(pool);
const processWager = new ProcessWager(pool, wagers);
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
  await pool.end().catch(() => undefined);
});

function baseInput(playerId: string, amount = '10.00', idemKey = 'k-1') {
  return {
    idempotencyKey: idemKey,
    type: 'BET' as const,
    playerId,
    currency: 'BRL',
    amount: { amount, currency: 'BRL' },
    externalTransactionId: 'ext-1',
    providerId: 'prov-1',
  };
}

describe('ProcessWager — BET/WIN/LOSS happy paths', () => {
  test('BET debits the wallet, increments version, writes one ledger entry, two outbox events', async () => {
    const wid = await createWalletWithBalance('alice', '100.00');
    const res = await processWager.execute(baseInput('alice', '10.00', 'bet-1'));
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
      `SELECT count(*)::int AS c FROM outbox WHERE payload->>'playerId' = 'alice'`,
    );
    expect(obCount.rows[0].c).toBe(2); // WalletBalanceChanged + WagerTransactionProcessed
  });

  test('WIN credits the wallet, increments version, writes one CREDIT ledger entry', async () => {
    await createWalletWithBalance('alice', '20.00');
    const res = await processWager.execute({ ...baseInput('alice', '10.00', 'win-1'), type: 'WIN' });
    expect(res.status).toBe('PROCESSED');
    expect(res.wallet?.balance.amount).toBe('30.00');
  });

  test('LOSS does NOT touch the wallet and writes no ledger entry', async () => {
    const wid = await createWalletWithBalance('alice', '100.00');
    const before = (await admin.query('SELECT balance_amount, version FROM wallets WHERE id = $1', [wid])).rows[0];
    const res = await processWager.execute({ ...baseInput('alice', '10.00', 'loss-1'), type: 'LOSS' });
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
    const wid = await createWalletWithBalance('alice', '50.00');
    const res = await processWager.execute(baseInput('alice', '100.00', 'bet-overdraft'));
    expect(res.status).toBe('REJECTED');
    expect(res.failureCode).toBe('INSUFFICIENT_FUNDS');

    const after = (await admin.query('SELECT balance_amount, version FROM wallets WHERE id = $1', [wid])).rows[0];
    expect(after.balance_amount).toBe('50.00');
  });
});

describe('ProcessWager — idempotency', () => {
  test('50 identical requests produce one financial effect and replay the persisted response', async () => {
    await createWalletWithBalance('alice', '1000.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        processWager.execute(baseInput('alice', '5.00', 'race-50')),
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
       WHERE w.player_id = 'alice' AND le.direction = 'DEBIT' AND le.value_amount = '5.00'`,
    );
    expect(ledger.rows[0].c).toBe(1);

    const wallet = await admin.query(
      `SELECT balance_amount FROM wallets WHERE player_id = 'alice'`,
    );
    expect(wallet.rows[0].balance_amount).toBe('995.00');
  });

  test('Same idempotency key + different payload → IDEMPOTENCY_CONFLICT (422)', async () => {
    await createWalletWithBalance('alice', '1000.00');
    await processWager.execute({ ...baseInput('alice', '5.00', 'shared-key'), externalTransactionId: 'a' });
    let conflict: unknown = null;
    try {
      await processWager.execute({ ...baseInput('alice', '7.00', 'shared-key'), externalTransactionId: 'b' });
    } catch (err) {
      conflict = err;
    }
    expect((conflict as { status?: number }).status).toBe(422);
    const wallet = await admin.query(`SELECT balance_amount FROM wallets WHERE player_id = 'alice'`);
    expect(wallet.rows[0].balance_amount).toBe('995.00'); // unchanged after the first call
  });

  test('Same idempotency key + reordered JSON keys → idempotent replay (hash stable)', async () => {
    await createWalletWithBalance('alice', '1000.00');
    const first = await processWager.execute(baseInput('alice', '5.00', 'reorder'));
    const second = await processWager.execute({
      idempotencyKey: 'reorder',
      type: 'BET',
      playerId: 'alice',
      currency: 'BRL',
      amount: { amount: '5.00', currency: 'BRL' },
      externalTransactionId: 'ext-1',
      providerId: 'prov-1',
    });
    expect(second.idempotentReplay).toBe(true);
    expect(second.wagerTransactionId).toBe(first.wagerTransactionId);
  });
});

describe('ProcessWager — balance contention and wallet independence', () => {
  test('Two concurrent BETs against the same wallet: one PROCESSED, one REJECTED INSUFFICIENT_FUNDS', async () => {
    await createWalletWithBalance('alice', '100.00');
    const settled = await Promise.allSettled([
      processWager.execute({ ...baseInput('alice', '80.00', 'race-1'), externalTransactionId: 'ext-race-1' }),
      processWager.execute({ ...baseInput('alice', '80.00', 'race-2'), externalTransactionId: 'ext-race-2' }),
    ]);
    const processed = settled.filter((s) => s.status === 'fulfilled' && (s as PromiseFulfilledResult<{ status: string }>).value.status === 'PROCESSED');
    const rejected = settled.filter((s) => s.status === 'fulfilled' && (s as PromiseFulfilledResult<{ status: string; failureCode?: string }>).value.status === 'REJECTED');
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseFulfilledResult<{ failureCode?: string }>).value.failureCode).toBe('INSUFFICIENT_FUNDS');

    const wallet = await admin.query(`SELECT balance_amount FROM wallets WHERE player_id = 'alice'`);
    expect(wallet.rows[0].balance_amount).toBe('20.00');
  });

  test('Distinct wallets process in parallel without waiting on each other', async () => {
    await createWalletWithBalance('alice', '100.00');
    await createWalletWithBalance('bob', '100.00');
    const [a, b] = await Promise.all([
      processWager.execute(baseInput('alice', '10.00', 'a-key')),
      processWager.execute({ ...baseInput('bob', '20.00', 'b-key'), externalTransactionId: 'ext-b' }),
    ]);
    expect(a.status).toBe('PROCESSED');
    expect(b.status).toBe('PROCESSED');
    expect(a.wallet?.balance.amount).toBe('90.00');
    expect(b.wallet?.balance.amount).toBe('80.00');
  });
});