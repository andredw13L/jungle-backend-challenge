import { Inject } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { Money } from '../../domain/money';
import { POOL } from './pool';

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  balanceCurrency: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpeningResult {
  wallet: WalletRow;
  openingTransactionId: string | null;
  openingEntryId: string | null;
  outboxEventId: string | null;
}

/**
 * WalletRepository — raw SQL behind a single transaction. Slice 3 wires
 * atomic wallet creation; slice 5 extends with `FOR UPDATE` lock and
 * idempotency, slice 9 with the multi-process harness.
 *
 * All money fields are read as strings (pg's default for NUMERIC).
 */
export class WalletRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async findById(id: string): Promise<WalletRow | null> {
    const r = await this.pool.query<RawWalletRow>(
      `SELECT id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at
       FROM wallets WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? toWalletRow(r.rows[0]) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<WalletRow | null> {
    const r = await this.pool.query<RawWalletRow>(
      `SELECT id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at
       FROM wallets WHERE player_id = $1 AND currency = $2`,
      [playerId, currency],
    );
    return r.rows[0] ? toWalletRow(r.rows[0]) : null;
  }

  /**
   * Atomic creation. Inserts the wallet row, then (when balance > 0) an
   * OPENING WagerTransaction, a CREDIT LedgerEntry, and the WalletBalanceChanged
   * Outbox event — all inside one transaction. `uq_wallet_player_currency`
   * and `uq_wager_idempotency_key` race-arbiter concurrent attempts.
   */
  async createAtomic(input: {
    id: string;
    playerId: string;
    initialBalance: Money;
    correlationId?: string;
  }): Promise<OpeningResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.runCreate(client, input);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async runCreate(
    client: PoolClient,
    input: {
      id: string;
      playerId: string;
      initialBalance: Money;
      correlationId?: string;
    },
  ): Promise<OpeningResult> {
    const zeroBalance = input.initialBalance.amount === '0.00';
    const walletInsert = await client.query<{ id: string; created_at: Date; updated_at: Date }>(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, balance_currency, version)
       VALUES ($1, $2, $3, $4, $3, 1)
       RETURNING id, created_at, updated_at`,
      [input.id, input.playerId, input.initialBalance.currency, input.initialBalance.amount],
    );
    const row = walletInsert.rows[0]!;
    const wallet: WalletRow = {
      id: row.id,
      playerId: input.playerId,
      currency: input.initialBalance.currency,
      balanceAmount: input.initialBalance.amount,
      balanceCurrency: input.initialBalance.currency,
      version: 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    if (zeroBalance) {
      return {
        wallet,
        openingTransactionId: null,
        openingEntryId: null,
        outboxEventId: null,
      };
    }

    const txInsert = await client.query<{ id: string }>(
      `INSERT INTO wager_transactions
         (type, status, wallet_id, provider_id, external_transaction_id,
          amount_amount, amount_currency, payload_hash, idempotency_key, processed_at)
       VALUES ('OPENING', 'PROCESSED', $1, '', '', $2, $3, '', $4, now())
       RETURNING id`,
      [wallet.id, input.initialBalance.amount, input.initialBalance.currency, `opening:${wallet.id}`],
    );
    const openingTxId = txInsert.rows[0]!.id;

    const entryInsert = await client.query<{ id: string }>(
      `INSERT INTO wallet_ledger_entries
         (direction, value_amount, value_currency,
          balance_before_amount, balance_before_currency,
          balance_after_amount, balance_after_currency,
          wallet_id, transaction_id)
       VALUES ('CREDIT', $1, $2, 0, $2, $1, $2, $3, $4)
       RETURNING id`,
      [input.initialBalance.amount, input.initialBalance.currency, wallet.id, openingTxId],
    );
    const openingEntryId = entryInsert.rows[0]!.id;

    const outboxInsert = await client.query<{ id: string }>(
      `INSERT INTO outbox (event_id, event_type, schema_version, payload, status, next_attempt_at)
       VALUES (uuidv7(), 'WalletBalanceChanged', 1, $1::jsonb, 'PENDING', now())
       RETURNING id`,
      [
        JSON.stringify({
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          walletVersion: wallet.version,
          direction: 'CREDIT',
          value: { amount: input.initialBalance.amount, currency: input.initialBalance.currency },
          balanceBefore: { amount: '0.00', currency: input.initialBalance.currency },
          balanceAfter: {
            amount: input.initialBalance.amount,
            currency: input.initialBalance.currency,
          },
          transactionId: openingTxId,
          correlationId: input.correlationId ?? null,
        }),
      ],
    );
    const outboxEventId = outboxInsert.rows[0]!.id;

    return {
      wallet,
      openingTransactionId: openingTxId,
      openingEntryId,
      outboxEventId,
    };
  }
}

interface RawWalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string | number;
  balance_currency: string;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

function toWalletRow(r: RawWalletRow): WalletRow {
  return {
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balanceAmount: String(r.balance_amount),
    balanceCurrency: r.balance_currency,
    version: Number(r.version),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}