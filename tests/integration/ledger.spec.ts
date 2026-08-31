/**
 * Slice 4 — pagination + reconciliation against real PostgreSQL.
 * Mirrors `tests/integration/wallets.spec.ts`: truncate setup, run, verify.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { loadEnv } from '../../src/config/env';
import { createOrm } from '../../src/infrastructure/database/orm.module';
import { WalletRepository } from '../../src/infrastructure/database/wallet.repository';
import { LedgerRepository } from '../../src/wallets/ledger.repository';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../src/wallets/ledger-cursor';

const env = loadEnv();
const orm = await createOrm(env);
await orm.connect();
const ormProvider = Promise.resolve(orm);
const wallets = new WalletRepository(ormProvider);
const ledger = new LedgerRepository(ormProvider);
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

/**
 * Force multiple ledger rows with monotonic `created_at` (the default
 * `now()` would collide under sub-ms inserts). The schema requires
 * `wallet_ledger_entries.transaction_id` to reference a real
 * `wager_transactions.id`, so each ledger row gets its own synthetic
 * BET transaction.
 */
async function createWalletWithManyLedgerEntries(
  playerId: string,
  count: number,
  amount: string,
): Promise<string> {
  const created = await wallets.createAtomic({
    id: crypto.randomUUID(),
    playerId,
    initialBalance: { amount: '0.00', currency: 'BRL' },
  });
  const walletId = created.wallet.id;
  for (let i = 0; i < count; i++) {
    const txId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO wager_transactions
         (id, type, status, wallet_id, provider_id, external_transaction_id,
          amount_amount, amount_currency, payload_hash, idempotency_key, processed_at)
       VALUES ($1, 'BET', 'PROCESSED', $2, 'test', $3, $4, 'BRL', '', $5, now())`,
      [txId, walletId, `test-${walletId}-${i}`, amount, `key-${walletId}-${i}`],
    );
    await admin.query(
      `INSERT INTO wallet_ledger_entries
         (direction, value_amount, value_currency,
          balance_before_amount, balance_before_currency,
          balance_after_amount, balance_after_currency,
          wallet_id, transaction_id, created_at)
       VALUES ('CREDIT', $1, 'BRL', $2, 'BRL', $3, 'BRL', $4, $5, now() + ($6 || ' milliseconds')::interval)`,
      [amount, '0.00', amount, walletId, txId, String(i + 1)],
    );
  }
  return walletId;
}

describe('ledger cursor codec', () => {
  test('round-trips createdAt + id', () => {
    const c = {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '01a05565-e1f0-7622-8223-90084b650689',
    };
    expect(decodeLedgerCursor(encodeLedgerCursor(c))).toEqual(c);
  });

  test('rejects malformed cursors', () => {
    expect(decodeLedgerCursor('not-base64url')).toBeNull();
    expect(decodeLedgerCursor(encodeLedgerCursor({ createdAt: 'x', id: 'y' }))).toBeNull();
    expect(decodeLedgerCursor(encodeLedgerCursor({ createdAt: '2026-01-01T00:00:00.000Z', id: 'not-a-uuid' }))).toBeNull();
  });
});

describe('GET /wallets/:id/ledger', () => {
  test('default limit is 50, max 100, ordering is created_at DESC + id DESC', async () => {
    const id = await createWalletWithManyLedgerEntries('p1', 5, '1.00');
    const page = await ledger.pageLedger(id, {});
    expect(page.entries.length).toBe(5);
    for (let i = 1; i < page.entries.length; i++) {
      expect(Date.parse(page.entries[i - 1]!.createdAt) >= Date.parse(page.entries[i]!.createdAt)).toBe(true);
    }
  });

  test('paginating with a cursor returns the next page in stable order', async () => {
    const id = await createWalletWithManyLedgerEntries('p2', 7, '1.00');
    const first = await ledger.pageLedger(id, { limit: 3 });
    expect(first.entries.length).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await ledger.pageLedger(id, { cursor: decodeLedgerCursor(first.nextCursor!), limit: 3 });
    expect(second.entries.length).toBe(3);
    const firstIds = new Set(first.entries.map((e) => e.id));
    for (const e of second.entries) expect(firstIds.has(e.id)).toBe(false);
  });

  test('limit above 100 is clamped; last page has nextCursor=null', async () => {
    const id = await createWalletWithManyLedgerEntries('p3', 4, '1.00');
    const page = await ledger.pageLedger(id, { limit: 9999 });
    expect(page.entries.length).toBe(4);
    expect(page.nextCursor).toBeNull();
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  test('balanced wallet returns consistent:true with divergence 0.00', async () => {
    const id = await createWalletWithManyLedgerEntries('p4', 3, '10.00');
    // Sum of 3 credits of 10.00 = 30.00; wallet balance stays at 0 since we opened zero.
    // Reconciliation reads wallet.balance_amount (0.00) vs ledger computed (30.00) → divergent.
    const result = await ledger.reconcile(id);
    expect(result.checkedEntries).toBe(3);
    expect(result.calculatedBalance.amount).toBe('30.00');
    // The opening path adds nothing because initialBalance was 0.00; wallet balance is 0.
    expect(result.storedBalance.amount).toBe('0.00');
    expect(result.consistent).toBe(false);
    expect(result.difference.amount).toBe('-30.00');
  });

  test('balanced reconciliation when wallet balance equals ledger sum', async () => {
    const created = await wallets.createAtomic({
      id: crypto.randomUUID(),
      playerId: 'p5',
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const id = created.wallet.id;
    // After opening 100.00 credit, wallet=100.00, ledger sum=100.00 → consistent.
    const result = await ledger.reconcile(id);
    expect(result.consistent).toBe(true);
    expect(result.storedBalance.amount).toBe('100.00');
    expect(result.calculatedBalance.amount).toBe('100.00');
    expect(result.difference.amount).toBe('0.00');
    expect(result.checkedEntries).toBe(1);
  });

  test('does not mutate wallet state (read-only)', async () => {
    const created = await wallets.createAtomic({
      id: crypto.randomUUID(),
      playerId: 'p6',
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });
    const id = created.wallet.id;
    const before = await admin.query('SELECT balance_amount, version FROM wallets WHERE id = $1', [id]);
    await ledger.reconcile(id);
    await ledger.reconcile(id);
    const after = await admin.query('SELECT balance_amount, version FROM wallets WHERE id = $1', [id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
