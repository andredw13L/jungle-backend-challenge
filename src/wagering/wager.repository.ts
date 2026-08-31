import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { POOL } from '../infrastructure/database/pool';
import { payloadHash } from '../domain/canonical-json';
import type { MoneyProps } from '../domain/money';

/**
 * WagerRepository — raw SQL for the `wager_transactions` table and the
 * `FOR UPDATE` lock on the wallet row that slices 5/6 use for
 * per-wallet serialisation. Slice 5 reads from this; later slices
 * extend with reference-reversal helpers.
 */
@Injectable()
export class WagerRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * Look up an existing wager transaction by idempotency key.
   * Returns null when missing. Used by ProcessWager to detect replays.
   */
  async findByIdempotencyKey(
    client: PoolClient,
    idempotencyKey: string,
  ): Promise<WagerRow | null> {
    const r = await client.query<WagerRow>(
      `SELECT id, type, status, wallet_id, provider_id, external_transaction_id,
              amount_amount, amount_currency, payload_hash, response_payload, failure_code
       FROM wager_transactions
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Insert a PENDING wager transaction row. Caller is responsible for
   * catching the 23505 unique violation and replaying from the
   * persisted row.
   */
  async insertPending(
    client: PoolClient,
    input: {
      id: string;
      type: 'BET' | 'WIN' | 'LOSS';
      walletId: string;
      providerId: string;
      externalTransactionId: string;
      amount: MoneyProps;
      payloadHash: string;
      idempotencyKey: string;
    },
  ): Promise<{ id: string }> {
    const r = await client.query<{ id: string }>(
      `INSERT INTO wager_transactions
         (id, type, status, wallet_id, provider_id, external_transaction_id,
          amount_amount, amount_currency, payload_hash, idempotency_key)
       VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.id,
        input.type,
        input.walletId,
        input.providerId,
        input.externalTransactionId,
        input.amount.amount,
        input.amount.currency,
        input.payloadHash,
        input.idempotencyKey,
      ],
    );
    return r.rows[0]!;
  }

  async findByIdPublic(id: string): Promise<WagerRowWithTimestamp | null> {
    const r = await this.pool.query<WagerRowWithTimestamp>(
      `SELECT id, type, status, wallet_id, provider_id, external_transaction_id,
              amount_amount, amount_currency, payload_hash, response_payload, failure_code, processed_at
       FROM wager_transactions WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async findByProviderAndExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerRow | null> {
    const r = await this.pool.query<WagerRow>(
      `SELECT id, type, status, wallet_id, provider_id, external_transaction_id,
              amount_amount, amount_currency, payload_hash, response_payload, failure_code, processed_at
       FROM wager_transactions
       WHERE provider_id = $1 AND external_transaction_id = $2`,
      [providerId, externalTransactionId],
    );
    return r.rows[0] ?? null;
  }

  async markProcessed(
    client: PoolClient,
    id: string,
    responsePayload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `UPDATE wager_transactions
       SET status = 'PROCESSED', response_payload = $2::jsonb, processed_at = now()
       WHERE id = $1`,
      [id, JSON.stringify(responsePayload)],
    );
  }

  async markRejected(
    client: PoolClient,
    id: string,
    failureCode: string,
    responsePayload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `UPDATE wager_transactions
       SET status = 'REJECTED', failure_code = $2, response_payload = $3::jsonb, processed_at = now()
       WHERE id = $1`,
      [id, failureCode, JSON.stringify(responsePayload)],
    );
  }

  /**
   * Look up the wallet inside the same transaction, applying
   * `FOR UPDATE` so two concurrent wagers against the same wallet
   * serialise (one waits for the other). For LOSS — which doesn't
   * mutate the wallet — the caller skips this and goes straight to
   * INSERT into `wager_transactions`.
   */
  async lockWallet(client: PoolClient, playerId: string, currency: string): Promise<WalletRow | null> {
    const r = await client.query<WalletRow>(
      `SELECT id, player_id, currency, balance_amount, balance_currency, version
       FROM wallets
       WHERE player_id = $1 AND currency = $2
       FOR UPDATE`,
      [playerId, currency],
    );
    return r.rows[0] ?? null;
  }

  async insertLedgerEntry(
    client: PoolClient,
    input: {
      direction: 'DEBIT' | 'CREDIT';
      valueAmount: string;
      valueCurrency: string;
      balanceBeforeAmount: string;
      balanceBeforeCurrency: string;
      balanceAfterAmount: string;
      balanceAfterCurrency: string;
      walletId: string;
      transactionId: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO wallet_ledger_entries
         (direction, value_amount, value_currency,
          balance_before_amount, balance_before_currency,
          balance_after_amount, balance_after_currency,
          wallet_id, transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.direction,
        input.valueAmount,
        input.valueCurrency,
        input.balanceBeforeAmount,
        input.balanceBeforeCurrency,
        input.balanceAfterAmount,
        input.balanceAfterCurrency,
        input.walletId,
        input.transactionId,
      ],
    );
  }

  async applyWalletMutation(
    client: PoolClient,
    walletId: string,
    newBalanceAmount: string,
  ): Promise<void> {
    await client.query(
      `UPDATE wallets
       SET balance_amount = $2, version = version + 1, updated_at = now()
       WHERE id = $1`,
      [walletId, newBalanceAmount],
    );
  }

  async insertOutboxEvent(
    client: PoolClient,
    input: {
      eventId: string;
      eventType: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox (event_id, event_type, schema_version, payload, status, next_attempt_at)
       VALUES ($1, $2, 1, $3::jsonb, 'PENDING', now())`,
      [input.eventId, input.eventType, JSON.stringify(input.payload)],
    );
  }
}

export interface WagerRow {
  id: string;
  type: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'OPENING';
  status: 'PENDING' | 'PROCESSED' | 'REJECTED' | 'FAILED';
  wallet_id: string;
  provider_id: string;
  external_transaction_id: string;
  amount_amount: string;
  amount_currency: string;
  payload_hash: string;
  response_payload: Record<string, unknown> | null;
  failure_code: string | null;
  processed_at: Date | null;
}

export type WagerRowWithTimestamp = WagerRow;

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  balance_currency: string;
  version: number;
}

/** Build a canonical payload hash from the business fields only (no transport metadata). */
export function wagerPayloadHash(input: {
  type: string;
  amount: MoneyProps;
  playerId: string;
  currency: string;
  externalTransactionId: string;
  providerId: string;
  reference?: string;
}): string {
  return payloadHash({
    type: input.type,
    amount: input.amount,
    playerId: input.playerId,
    currency: input.currency,
    externalTransactionId: input.externalTransactionId,
    providerId: input.providerId,
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
  });
}