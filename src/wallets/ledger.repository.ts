import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../infrastructure/database/pool';
import { encodeLedgerCursor, type LedgerCursor } from './ledger-cursor';

export interface LedgerEntryView {
  id: string;
  direction: 'DEBIT' | 'CREDIT';
  value: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  transactionId: string;
  createdAt: string;
}

export interface LedgerPage {
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationResult {
  consistent: boolean;
  walletBalance: { amount: string; currency: string };
  ledgerComputed: { amount: string; currency: string };
  divergence: { amount: string; currency: string };
  entryCount: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * LedgerRepository — paginated reads + reconciliation. Slice 4 only
 * adds SELECT; writes go through `WalletRepository`. Reconciliation is
 * strictly read-only — it reports divergence and never mutates state.
 */
@Injectable()
export class LedgerRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async pageLedger(
    walletId: string,
    options: { cursor?: LedgerCursor | null; limit?: number } = {},
  ): Promise<LedgerPage> {
    const limit = clampLimit(options.limit ?? DEFAULT_LIMIT);
    const params: unknown[] = [walletId];
    let cursorClause = '';
    if (options.cursor) {
      params.push(options.cursor.createdAt);
      params.push(options.cursor.id);
      cursorClause = `AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
    }
    params.push(limit);
    const limitParam = `$${params.length}`;

    const r = await this.pool.query<RawLedgerRow>(
      `SELECT id, direction, value_amount, value_currency,
              balance_before_amount, balance_before_currency,
              balance_after_amount, balance_after_currency,
              transaction_id, created_at
       FROM wallet_ledger_entries
       WHERE wallet_id = $1 ${cursorClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitParam}`,
      params,
    );
    const entries = r.rows.map(toView);
    const last = entries[entries.length - 1];
    const nextCursor =
      entries.length === limit && last
        ? encodeLedgerCursor({ createdAt: last.createdAt, id: last.id })
        : null;
    return { entries, nextCursor };
  }

  /**
   * Compute the Ledger's view of the balance and compare to the wallet's
   * stored balance. The Ledger sum uses `NUMERIC` arithmetic so it never
   * loses precision; divergence is reported as a positive decimal when
   * the stored balance is greater than the computed one.
   */
  async reconcile(walletId: string): Promise<ReconciliationResult> {
    // Single LEFT JOIN query: PostgreSQL computes the divergence in NUMERIC,
    // so the value never leaves the schema's exact decimal domain.
    const r = await this.pool.query<{
      wallet_amount: string;
      balance_currency: string;
      computed: string | null;
      entries: string | number;
      divergence: string | null;
    }>(
      `SELECT
         wb.balance_amount                                       AS wallet_amount,
         wb.balance_currency,
         COALESCE(SUM(CASE WHEN le.direction = 'CREDIT'
                           THEN le.value_amount
                           ELSE -le.value_amount END), 0)        AS computed,
         COUNT(le.id)::bigint                                    AS entries,
         COALESCE(
           wb.balance_amount
             - COALESCE(SUM(CASE WHEN le.direction = 'CREDIT'
                                THEN le.value_amount
                                ELSE -le.value_amount END), 0),
           wb.balance_amount
         )                                                       AS divergence
       FROM wallets wb
       LEFT JOIN wallet_ledger_entries le ON le.wallet_id = wb.id
       WHERE wb.id = $1
       GROUP BY wb.balance_amount, wb.balance_currency`,
      [walletId],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error(`wallet ${walletId} not found`);
    }
    const walletBalance = { amount: String(row.wallet_amount), currency: row.balance_currency };
    const ledgerComputed = { amount: String(row.computed), currency: row.balance_currency };
    const divergenceAmount = String(row.divergence);
    const divergence = { amount: divergenceAmount, currency: row.balance_currency };
    const consistent = divergenceAmount === '0.00';
    return {
      consistent,
      walletBalance,
      ledgerComputed,
      divergence,
      entryCount: Number(row.entries),
    };
  }
}

interface RawLedgerRow {
  id: string;
  direction: 'DEBIT' | 'CREDIT';
  value_amount: string;
  value_currency: string;
  balance_before_amount: string;
  balance_before_currency: string;
  balance_after_amount: string;
  balance_after_currency: string;
  transaction_id: string;
  created_at: Date;
}

function toView(r: RawLedgerRow): LedgerEntryView {
  return {
    id: r.id,
    direction: r.direction,
    value: { amount: String(r.value_amount), currency: r.value_currency },
    balanceBefore: {
      amount: String(r.balance_before_amount),
      currency: r.balance_before_currency,
    },
    balanceAfter: {
      amount: String(r.balance_after_amount),
      currency: r.balance_after_currency,
    },
    transactionId: r.transaction_id,
    createdAt: r.created_at.toISOString(),
  };
}

function clampLimit(n: number): number {
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}