import { Inject } from '@nestjs/common';
import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import type { MoneyProps } from '../../domain/money';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { v7 as uuidv7 } from 'uuid';
import { MIKRO_ORM } from './entities';
import type { AppOrm } from './orm.module';

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
  constructor(@Inject(MIKRO_ORM) private readonly orm: Promise<AppOrm>) {}

  async findById(id: string): Promise<WalletRow | null> {
    const r = await (await this.orm).em.fork().execute<RawWalletRow[]>(
      `SELECT id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at
       FROM wallets WHERE id = ?`,
      [id],
    );
    return r[0] ? toWalletRow(r[0]) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<WalletRow | null> {
    const r = await (await this.orm).em.fork().execute<RawWalletRow[]>(
      `SELECT id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at
       FROM wallets WHERE player_id = ? AND currency = ?`,
      [playerId, currency],
    );
    return r[0] ? toWalletRow(r[0]) : null;
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
    initialBalance: MoneyProps;
    correlationId?: string;
  }): Promise<OpeningResult> {
    const orm = await this.orm;
    return orm.em.fork().transactional(
      (em) => this.runCreate(em, input),
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
  }

  private async runCreate(
    em: PostgreSqlEntityManager,
    input: {
      id: string;
      playerId: string;
      initialBalance: MoneyProps;
      correlationId?: string;
    },
  ): Promise<OpeningResult> {
    const zeroBalance = input.initialBalance.amount === '0.00';
    const walletInsert = await em.execute<{ id: string; created_at: Date; updated_at: Date }[]>(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, balance_currency, version)
       VALUES (?, ?, ?, ?, ?, 1)
       RETURNING id, created_at, updated_at`,
      [
        input.id,
        input.playerId,
        input.initialBalance.currency,
        input.initialBalance.amount,
        input.initialBalance.currency,
      ],
    );
    const row = walletInsert[0]!;
    const wallet: WalletRow = {
      id: row.id,
      playerId: input.playerId,
      currency: input.initialBalance.currency,
      balanceAmount: input.initialBalance.amount,
      balanceCurrency: input.initialBalance.currency,
      version: 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };

    if (zeroBalance) {
      return {
        wallet,
        openingTransactionId: null,
        openingEntryId: null,
        outboxEventId: null,
      };
    }

    const txInsert = await em.execute<{ id: string }[]>(
      `INSERT INTO wager_transactions
         (type, status, wallet_id, player_id, provider_id, external_transaction_id,
          amount_amount, amount_currency, payload_hash, idempotency_key, processed_at)
       VALUES ('OPENING', 'PROCESSED', ?, ?, ?, ?, ?, ?, '', ?, now())
       RETURNING id`,
      [
        wallet.id,
        wallet.playerId,
        `internal:${wallet.id}`,
        `opening:${wallet.id}`,
        input.initialBalance.amount,
        input.initialBalance.currency,
        `opening:${wallet.id}`,
      ],
    );
    const openingTxId = txInsert[0]!.id;

    const entryInsert = await em.execute<{ id: string }[]>(
      `INSERT INTO wallet_ledger_entries
         (direction, value_amount, value_currency,
          balance_before_amount, balance_before_currency,
          balance_after_amount, balance_after_currency,
          wallet_id, transaction_id)
       VALUES ('CREDIT', ?, ?, 0, ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        input.initialBalance.amount,
        input.initialBalance.currency,
        input.initialBalance.currency,
        input.initialBalance.amount,
        input.initialBalance.currency,
        wallet.id,
        openingTxId,
      ],
    );
    const openingEntryId = entryInsert[0]!.id;

    const openingEvent = new WalletBalanceChanged(
      uuidv7(),
      new Date(),
      input.correlationId,
      {
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
      },
    );
    const outboxInsert = await em.execute<{ id: string }[]>(
      `INSERT INTO outbox (event_id, event_type, schema_version, payload, status, next_attempt_at)
       VALUES (?, ?, ?, ?::jsonb, 'PENDING', now())
       RETURNING id`,
      [openingEvent.eventId, openingEvent.eventType, openingEvent.version, JSON.stringify(openingEvent.toJSON())],
    );
    const outboxEventId = outboxInsert[0]!.id;

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
  created_at: Date | string;
  updated_at: Date | string;
}

function toWalletRow(r: RawWalletRow): WalletRow {
  return {
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balanceAmount: String(r.balance_amount),
    balanceCurrency: r.balance_currency,
    version: Number(r.version),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}
