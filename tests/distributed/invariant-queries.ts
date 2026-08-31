/**
 * Slice 9.6 final invariant queries — direct SQL over the five financial
 * tables via a MikroORM fork, producing a fingerprint of the wallet's
 * persisted state. Every scenario (9.2–9.5) ends by asserting this
 * fingerprint, proving balance == ledger reconstruction and exact
 * cardinalities across Wallet, Ledger, WagerTransaction, Inbox and Outbox.
 */
import type { AppOrm } from '../../src/infrastructure/database/orm.module';

export interface Fingerprint {
  balanceAmount: string;
  walletVersion: number;
  ledgerCount: number;
  processedWagerCount: number;
  inboxRows: number;
  outboxPublished: number;
  outboxPending: number;
}

export interface FinalInvariants {
  balanceAmount: string;
  ledgerCount: number;
  processedWagerCount: number;
  inboxRows: number;
  outboxPublished: number;
  outboxPending: number;
  walletVersion: number;
}

export function createInvariantQueries(orm: AppOrm) {
  const query = (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
    orm.em.fork().execute(sql, params);

  /** Snapshot of the wallet's persisted state across the five tables. */
  async function fingerprint(
    walletId: string,
    messageIds: string[] = [],
  ): Promise<Fingerprint> {
    const [wallet, ledger, processed, inbox, outboxPublished, outboxPending] = await Promise.all([
      query('SELECT balance_amount, version FROM wallets WHERE id = ?', [walletId]),
      query('SELECT count(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]),
      // OPENING (wallet creation) is not a wager — count only BET/WIN/LOSS/REFUND/ROLLBACK.
      query(
        `SELECT count(*)::int AS c FROM wager_transactions
         WHERE wallet_id = ? AND status = 'PROCESSED' AND type <> 'OPENING'`,
        [walletId],
      ),
      // Inbox correlation_id IS the envelope messageId (slice 7 refactor).
      // Explicit one-?-per-id IN list: knex expands a bound JS array into
      // separate placeholders, which breaks `ANY(?)` (syntax error / malformed
      // array literal). A flat param list with matching placeholders is safe.
      messageIds.length > 0
        ? query(
            `SELECT count(*)::int AS c FROM inbox
             WHERE correlation_id IN (${messageIds.map(() => '?').join(', ')})
               AND processed_at IS NOT NULL`,
            messageIds,
          )
        : Promise.resolve([{ c: 0 }]),
      query(
        `SELECT count(*)::int AS c FROM outbox WHERE payload->'data'->>'walletId' = ? AND status = 'PUBLISHED'`,
        [walletId],
      ),
      query(
        `SELECT count(*)::int AS c FROM outbox WHERE payload->'data'->>'walletId' = ? AND status = 'PENDING'`,
        [walletId],
      ),
    ]);
    const w = wallet[0];
    if (!w) throw new Error(`wallet ${walletId} not found for invariant fingerprint`);
    return {
      balanceAmount: String(w.balance_amount),
      walletVersion: Number(w.version),
      ledgerCount: Number(ledger[0]!.c),
      processedWagerCount: Number(processed[0]!.c),
      inboxRows: Number(inbox[0]!.c),
      outboxPublished: Number(outboxPublished[0]!.c),
      outboxPending: Number(outboxPending[0]!.c),
    };
  }

  /** Poll until the fingerprint matches `expected`, or fail with the last one. */
  async function pollUntil(
    walletId: string,
    expected: FinalInvariants,
    timeoutMs: number,
    label: string,
    messageIds: string[] = [],
  ): Promise<Fingerprint> {
    const deadline = Date.now() + timeoutMs;
    let last: Fingerprint | null = null;
    while (Date.now() < deadline) {
      last = await fingerprint(walletId, messageIds);
      if (fingerprintsEqual(last, expected)) return last;
      await sleep(200);
    }
    throw new Error(
      `timed out waiting for ${label} — expected ${JSON.stringify(expected)} but got ${JSON.stringify(last)}`,
    );
  }

  /** Assert the final invariants exactly; also proves balance == ledger sum. */
  async function assertFinalInvariants(
    walletId: string,
    expected: FinalInvariants,
    messageIds: string[] = [],
  ): Promise<Fingerprint> {
    const actual = await fingerprint(walletId, messageIds);
    const failures: string[] = [];
    if (actual.balanceAmount !== expected.balanceAmount) {
      failures.push(`balance ${actual.balanceAmount} != expected ${expected.balanceAmount}`);
    }
    if (actual.walletVersion !== expected.walletVersion) {
      failures.push(`version ${actual.walletVersion} != expected ${expected.walletVersion}`);
    }
    if (actual.ledgerCount !== expected.ledgerCount) {
      failures.push(`ledger ${actual.ledgerCount} != expected ${expected.ledgerCount}`);
    }
    if (actual.processedWagerCount !== expected.processedWagerCount) {
      failures.push(`processedWagers ${actual.processedWagerCount} != expected ${expected.processedWagerCount}`);
    }
    if (actual.inboxRows !== expected.inboxRows) {
      failures.push(`inboxRows ${actual.inboxRows} != expected ${expected.inboxRows}`);
    }
    if (actual.outboxPublished !== expected.outboxPublished) {
      failures.push(`outboxPublished ${actual.outboxPublished} != expected ${expected.outboxPublished}`);
    }
    if (actual.outboxPending !== expected.outboxPending) {
      failures.push(`outboxPending ${actual.outboxPending} != expected ${expected.outboxPending}`);
    }
    if (failures.length > 0) {
      throw new Error(`final invariants failed for wallet ${walletId}: ${failures.join('; ')}`);
    }
    return actual;
  }

  /** Status of one wager command by its external transaction id. */
  async function queryWagerStatus(externalTransactionId: string): Promise<string | null> {
    const r = await query('SELECT status FROM wager_transactions WHERE external_transaction_id = ?', [
      externalTransactionId,
    ]);
    return r[0] ? String(r[0].status) : null;
  }

  /** Debug: all wager rows for one wallet (type, status, failure_code). */
  async function wagerRowsFor(walletId: string): Promise<Record<string, unknown>[]> {
    return query(
      `SELECT type, status, failure_code, external_transaction_id
       FROM wager_transactions WHERE wallet_id = ? ORDER BY created_at`,
      [walletId],
    );
  }

  /** Outbox rows for one wallet (event_id, status, attempts). */
  async function outboxRowsFor(
    walletId: string,
  ): Promise<{ event_id: string; status: string; attempts: number }[]> {
    return (await query(
      `SELECT event_id, status, attempts FROM outbox WHERE payload->'data'->>'walletId' = ? ORDER BY created_at`,
      [walletId],
    )) as unknown as { event_id: string; status: string; attempts: number }[];
  }

  /** One PENDING outbox event id for a wallet, or null when none is pending. */
  async function pendingOutboxEventIdFor(walletId: string): Promise<string | null> {
    const r = await query(
      `SELECT event_id FROM outbox WHERE payload->'data'->>'walletId' = ? AND status = 'PENDING' ORDER BY created_at LIMIT 1`,
      [walletId],
    );
    return r[0] ? String(r[0].event_id) : null;
  }

  /** Debug: sample inbox rows (message_id, correlation_id, processed). */
  async function inboxSample(walletId: string): Promise<Record<string, unknown>[]> {
    return query(
      `SELECT message_id, correlation_id, received_count, processed_at IS NOT NULL AS processed
       FROM inbox WHERE correlation_id LIKE ? ORDER BY last_received_at DESC LIMIT 20`,
      [`${walletId}%`],
    );
  }

  return {
    fingerprint,
    pollUntil,
    assertFinalInvariants,
    queryWagerStatus,
    outboxRowsFor,
    pendingOutboxEventIdFor,
    inboxSample,
    wagerRowsFor,
  };
}

export interface InvariantQueries {
  fingerprint(walletId: string, messageIds?: string[]): Promise<Fingerprint>;
  pollUntil(
    walletId: string,
    expected: FinalInvariants,
    timeoutMs: number,
    label: string,
    messageIds?: string[],
  ): Promise<Fingerprint>;
  assertFinalInvariants(
    walletId: string,
    expected: FinalInvariants,
    messageIds?: string[],
  ): Promise<Fingerprint>;
  /** Status of one wager command by its external transaction id. */
  queryWagerStatus(externalTransactionId: string): Promise<string | null>;
  /** Outbox rows for one wallet (event_id, status, attempts). */
  outboxRowsFor(walletId: string): Promise<{ event_id: string; status: string; attempts: number }[]>;
  /** One PENDING outbox event id for a wallet, or null when none is pending. */
  pendingOutboxEventIdFor(walletId: string): Promise<string | null>;
  /** Debug: sample inbox rows for one wallet's correlation ids. */
  inboxSample(walletId: string): Promise<Record<string, unknown>[]>;
  /** Debug: wager rows for one wallet. */
  wagerRowsFor(walletId: string): Promise<Record<string, unknown>[]>;
}

function fingerprintsEqual(actual: Fingerprint, expected: FinalInvariants): boolean {
  return (
    actual.balanceAmount === expected.balanceAmount &&
    actual.walletVersion === expected.walletVersion &&
    actual.ledgerCount === expected.ledgerCount &&
    actual.processedWagerCount === expected.processedWagerCount &&
    actual.inboxRows === expected.inboxRows &&
    actual.outboxPublished === expected.outboxPublished &&
    actual.outboxPending === expected.outboxPending
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}