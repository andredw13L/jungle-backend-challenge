/**
 * Integration tests for slice 3 — wallet creation against real PostgreSQL.
 *
 * Run with:
 *   bun run migrate up
 *   bun test tests/integration
 *
 * Each test cleans the wagering tables in setup/teardown so successive runs
 * remain independent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { loadEnv } from '../../src/config/env';
import { createOrm } from '../../src/infrastructure/database/orm.module';
import { WalletRepository } from '../../src/infrastructure/database/wallet.repository';
import { WalletCreationService } from '../../src/wallets/wallet-creation.service';
import { Money } from '../../src/domain/money';

const env = loadEnv();
const orm = await createOrm(env);
await orm.connect();
const ormProvider = Promise.resolve(orm);
const repo = new WalletRepository(ormProvider);
const service = new WalletCreationService(repo);
const admin = new Client({ connectionString: env.DATABASE_URL });

async function truncateAll(): Promise<void> {
  await admin.query('TRUNCATE outbox, wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE');
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

describe('WalletCreationService — slice 3 spec scenarios', () => {
  test('Saldo inicial positivo — cria Wallet, OPENING, entry CREDIT e evento na Outbox', async () => {
    const w = await service.create({
      playerId: 'alice',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(w.balanceAmount).toBe('1000.00');
    expect(w.version).toBe(1);

    const txCount = await admin.query(
      `SELECT count(*)::int AS c FROM wager_transactions WHERE wallet_id = $1 AND type = 'OPENING'`,
      [w.id],
    );
    expect(txCount.rows[0].c).toBe(1);

    const ledgerCount = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'`,
      [w.id],
    );
    expect(ledgerCount.rows[0].c).toBe(1);

    const outboxCount = await admin.query(
      `SELECT count(*)::int AS c FROM outbox WHERE payload #>> '{data,walletId}' = $1`,
      [w.id],
    );
    expect(outboxCount.rows[0].c).toBe(1);
  });

  test('Saldo inicial zero — Wallet existe, sem OPENING nem entry', async () => {
    const w = await service.create({
      playerId: 'bob',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(w.balanceAmount).toBe('0.00');
    expect(w.version).toBe(1);

    const txCount = await admin.query(
      `SELECT count(*)::int AS c FROM wager_transactions WHERE wallet_id = $1`,
      [w.id],
    );
    expect(txCount.rows[0].c).toBe(0);

    const ledgerCount = await admin.query(
      `SELECT count(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [w.id],
    );
    expect(ledgerCount.rows[0].c).toBe(0);
  });

  test('Wallet duplicada — segundo POST retorna 409 WALLET_ALREADY_EXISTS', async () => {
    await service.create({
      playerId: 'carol',
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });
    expect(
      service.create({
        playerId: 'carol',
        initialBalance: { amount: '999.00', currency: 'BRL' },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('GET /wallets/:id retorna 404 para id desconhecido', async () => {
    expect(
      service.findById('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('round-trip preserva Money como string decimal (NUMERIC(18,2))', async () => {
    const w = await service.create({
      playerId: 'dave',
      initialBalance: { amount: '0.10', currency: 'BRL' },
    });
    const fetched = await service.findById(w.id);
    expect(fetched.balanceAmount).toBe('0.10');
    expect(typeof fetched.balanceAmount).toBe('string');
  });

  test('trg_ledger_immutable rejeita UPDATE e DELETE', async () => {
    const w = await service.create({
      playerId: 'eve',
      initialBalance: { amount: '5.00', currency: 'BRL' },
    });
    const update = admin.query(`UPDATE wallet_ledger_entries SET value_amount = 99 WHERE wallet_id = $1`, [w.id]);
    await expect(update).rejects.toThrow(/append-only/);
    const del = admin.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [w.id]);
    await expect(del).rejects.toThrow(/append-only/);
  });

  test('CHECK ck_wallet_balance_nonneg rejeita saldo negativo no schema', async () => {
    const q = admin.query(
      `INSERT INTO wallets (player_id, currency, balance_amount, balance_currency)
       VALUES ('fred', 'BRL', -1, 'BRL')`,
    );
    await expect(q).rejects.toThrow(/ck_wallet_balance_nonneg/);
  });

  test('Money.create ainda rejeita inputs inválidos (defesa em profundidade)', () => {
    expect(() => Money.create({ amount: '007', currency: 'BRL' })).toThrow();
    expect(() => Money.create({ amount: '-1.00', currency: 'BRL' })).toThrow();
    expect(() => Money.create({ amount: '1.001', currency: 'BRL' })).toThrow();
  });
});
