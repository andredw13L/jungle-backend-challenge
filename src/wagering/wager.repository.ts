import { Inject } from '@nestjs/common';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import type { MoneyProps } from '../domain/money';
import { payloadHash } from '../domain/canonical-json';
import type { IntegrationEvent } from '../domain/events/integration-event';
import { MIKRO_ORM } from '../infrastructure/database/entities';
import type { AppOrm } from '../infrastructure/database/orm.module';

/**
 * WagerRepository — raw SQL for the `wager_transactions` table, the
 * `FOR UPDATE` lock on the wallet row, and the worker helpers for
 * PENDING_REFERENCE reversals. Slices 5/6 use this directly; slice 7
 * extends the SQS consumer; slice 8 the Outbox publisher.
 */
export class WagerRepository {
  constructor(@Inject(MIKRO_ORM) private readonly orm: Promise<AppOrm>) {}

  async findByIdempotencyKey(
    em: PostgreSqlEntityManager,
    idempotencyKey: string,
  ): Promise<WagerRow | null> {
    const r = await em.execute<WagerRow[]>(
      `SELECT id, type, status, wallet_id, player_id, round_id, game_id,
              provider_id, external_transaction_id, amount_amount, amount_currency,
              reference_external_transaction_id, reference, payload_hash,
              response_payload, failure_code, processed_at, reference_attempts
       FROM wager_transactions
       WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    return r[0] ?? null;
  }

  async insertPending(
    em: PostgreSqlEntityManager,
    input: {
      id: string;
      type: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
      walletId: string;
      playerId: string;
      roundId: string;
      gameId: string;
      providerId: string;
      externalTransactionId: string;
      amount: MoneyProps;
      payloadHash: string;
      idempotencyKey: string;
      referenceExternalTransactionId?: string | undefined;
    },
  ): Promise<{ id: string }> {
    const r = await em.execute<{ id: string }[]>(
      `INSERT INTO wager_transactions
         (id, type, status, wallet_id, player_id, round_id, game_id,
          provider_id, external_transaction_id, amount_amount, amount_currency,
          reference_external_transaction_id, payload_hash, idempotency_key)
       VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        input.id,
        input.type,
        input.walletId,
        input.playerId,
        input.roundId,
        input.gameId,
        input.providerId,
        input.externalTransactionId,
        input.amount.amount,
        input.amount.currency,
        input.referenceExternalTransactionId ?? null,
        input.payloadHash,
        input.idempotencyKey,
      ],
    );
    return r[0]!;
  }

  async findByIdPublic(id: string): Promise<WagerRow | null> {
    const r = await (await this.orm).em.fork().execute<WagerRow[]>(
      `SELECT id, type, status, wallet_id, player_id, round_id, game_id,
              provider_id, external_transaction_id, amount_amount, amount_currency,
              reference_external_transaction_id, reference, payload_hash,
              response_payload, failure_code, processed_at, reference_attempts
       FROM wager_transactions WHERE id = ?`,
      [id],
    );
    return r[0] ? toWagerRow(r[0]) : null;
  }

  async findByProviderAndExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerRow | null> {
    const r = await (await this.orm).em.fork().execute<WagerRow[]>(
      `SELECT id, type, status, wallet_id, player_id, round_id, game_id,
              provider_id, external_transaction_id, amount_amount, amount_currency,
              reference_external_transaction_id, reference, payload_hash,
              response_payload, failure_code, processed_at, reference_attempts
       FROM wager_transactions
       WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return r[0] ? toWagerRow(r[0]) : null;
  }

  async findReferenceByProviderExternal(
    em: PostgreSqlEntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerRow | null> {
    const r = await em.execute<WagerRow[]>(
      `SELECT id, type, status, wallet_id, player_id, round_id, game_id,
              provider_id, external_transaction_id, amount_amount, amount_currency,
              reference_external_transaction_id, reference, payload_hash,
              response_payload, failure_code, processed_at, reference_attempts
       FROM wager_transactions
       WHERE provider_id = ? AND external_transaction_id = ?
       FOR UPDATE`,
      [providerId, externalTransactionId],
    );
    return r[0] ? toWagerRow(r[0]) : null;
  }

  async findReferenceByExternal(
    em: PostgreSqlEntityManager,
    externalTransactionId: string,
  ): Promise<WagerRow | null> {
    const r = await em.execute<WagerRow[]>(
      `SELECT id, type, status, wallet_id, player_id, round_id, game_id,
              provider_id, external_transaction_id, amount_amount, amount_currency,
              reference_external_transaction_id, reference, payload_hash,
              response_payload, failure_code, processed_at, reference_attempts
       FROM wager_transactions
       WHERE external_transaction_id = ?
       ORDER BY id
       LIMIT 1
       FOR UPDATE`,
      [externalTransactionId],
    );
    return r[0] ? toWagerRow(r[0]) : null;
  }

  async markProcessed(
    em: PostgreSqlEntityManager,
    id: string,
    responsePayload: Record<string, unknown>,
  ): Promise<void> {
    await em.execute(
      `UPDATE wager_transactions
       SET status = 'PROCESSED', response_payload = ?::jsonb, processed_at = now()
       WHERE id = ?`,
      [JSON.stringify(responsePayload), id],
    );
  }

  async markRejected(
    em: PostgreSqlEntityManager,
    id: string,
    failureCode: string,
    responsePayload: Record<string, unknown>,
    referenceAttempts?: number,
  ): Promise<void> {
    await em.execute(
      `UPDATE wager_transactions
       SET status = 'REJECTED', failure_code = ?, response_payload = ?::jsonb, processed_at = now()
           , reference_attempts = COALESCE(?, reference_attempts)
       WHERE id = ?`,
      [failureCode, JSON.stringify(responsePayload), referenceAttempts ?? null, id],
    );
  }

  async setReference(
    em: PostgreSqlEntityManager,
    id: string,
    referenceTransactionId: string,
  ): Promise<void> {
    await em.execute(
      `UPDATE wager_transactions SET reference = ? WHERE id = ?`,
      [referenceTransactionId, id],
    );
  }

  async lockWallet(
    em: PostgreSqlEntityManager,
    walletId: string,
    playerId: string,
    currency: string,
  ): Promise<WalletRow | null> {
    const r = await em.execute<WalletRow[]>(
      `SELECT id, player_id, currency, balance_amount, balance_currency, version
       FROM wallets
       WHERE id = ? AND player_id = ? AND currency = ?
       FOR UPDATE`,
      [walletId, playerId, currency],
    );
    return r[0] ?? null;
  }

  async lockWalletById(
    em: PostgreSqlEntityManager,
    walletId: string,
  ): Promise<WalletRow | null> {
    const r = await em.execute<WalletRow[]>(
      `SELECT id, player_id, currency, balance_amount, balance_currency, version
       FROM wallets WHERE id = ? FOR UPDATE`,
      [walletId],
    );
    return r[0] ?? null;
  }

  async lockReference(
    em: PostgreSqlEntityManager,
    referenceId: string,
  ): Promise<WagerRow | null> {
    const r = await em.execute<WagerRow[]>(
      `SELECT id, type, status, wallet_id, player_id, round_id, game_id,
              provider_id, external_transaction_id, amount_amount, amount_currency,
              reference_external_transaction_id, reference, payload_hash,
              response_payload, failure_code, processed_at, reference_attempts
       FROM wager_transactions
       WHERE id = ?
       FOR UPDATE`,
      [referenceId],
    );
    return r[0] ? toWagerRow(r[0]) : null;
  }

  async findReversalByReferenceType(
    em: PostgreSqlEntityManager,
    referenceTransactionId: string,
    type: 'REFUND' | 'ROLLBACK',
    excludeId: string,
  ): Promise<WagerRow | null> {
    const r = await em.execute<WagerRow[]>(
      `SELECT id, type, status, wallet_id, player_id, round_id, game_id,
              provider_id, external_transaction_id, amount_amount, amount_currency,
              reference_external_transaction_id, reference, payload_hash,
              response_payload, failure_code, processed_at, reference_attempts
       FROM wager_transactions
       WHERE reference = ? AND type = ? AND id <> ?
         AND status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE`,
      [referenceTransactionId, type, excludeId],
    );
    return r[0] ? toWagerRow(r[0]) : null;
  }

  async findPendingReferences(
    em: PostgreSqlEntityManager,
    maxRows: number,
  ): Promise<WagerRow[]> {
    const r = await em.execute<WagerRow[]>(
      `SELECT id, type, status, wallet_id, player_id, round_id, game_id,
              provider_id, external_transaction_id, amount_amount, amount_currency,
              reference_external_transaction_id, reference, payload_hash,
              response_payload, failure_code, processed_at, reference_attempts
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND next_retry_at <= now()
       ORDER BY next_retry_at
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [maxRows],
    );
    return r.map(toWagerRow);
  }

  async updatePendingRetry(
    em: PostgreSqlEntityManager,
    id: string,
    nextRetryAt: Date,
    attempts: number,
  ): Promise<void> {
    await em.execute(
      `UPDATE wager_transactions
       SET next_retry_at = ?, reference_attempts = ?
       WHERE id = ?`,
      [nextRetryAt, attempts, id],
    );
  }

  async transitionToPendingReference(
    em: PostgreSqlEntityManager,
    id: string,
    nextRetryAt: Date,
    initialAttempt: number,
    responsePayload: Record<string, unknown>,
  ): Promise<void> {
    await em.execute(
      `UPDATE wager_transactions
       SET status = 'PENDING_REFERENCE', next_retry_at = ?, reference_attempts = ?,
           response_payload = ?::jsonb
       WHERE id = ?`,
      [nextRetryAt, initialAttempt, JSON.stringify(responsePayload), id],
    );
  }

  async insertLedgerEntry(
    em: PostgreSqlEntityManager,
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
    await em.execute(
      `INSERT INTO wallet_ledger_entries
         (direction, value_amount, value_currency,
          balance_before_amount, balance_before_currency,
          balance_after_amount, balance_after_currency,
          wallet_id, transaction_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    em: PostgreSqlEntityManager,
    walletId: string,
    newBalanceAmount: string,
  ): Promise<void> {
    await em.execute(
      `UPDATE wallets
       SET balance_amount = ?, version = version + 1, updated_at = now()
       WHERE id = ?`,
      [newBalanceAmount, walletId],
    );
  }

  async insertOutboxEvent(
    em: PostgreSqlEntityManager,
    event: IntegrationEvent,
  ): Promise<void> {
    await em.execute(
      `INSERT INTO outbox (event_id, event_type, schema_version, payload, status, next_attempt_at)
       VALUES (?, ?, ?, ?::jsonb, 'PENDING', now())`,
      [event.eventId, event.eventType, event.version, JSON.stringify(event.toJSON())],
    );
  }
}

export interface WagerRow {
  id: string;
  type: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'OPENING';
  status: 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
  wallet_id: string;
  player_id: string | null;
  round_id: string | null;
  game_id: string | null;
  provider_id: string;
  external_transaction_id: string;
  amount_amount: string;
  amount_currency: string;
  reference_external_transaction_id: string | null;
  payload_hash: string;
  response_payload: Record<string, unknown> | null;
  failure_code: string | null;
  processed_at: Date | null;
  reference_attempts: number;
  reference: string | null;
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

function toWagerRow(row: WagerRow): WagerRow {
  return {
    ...row,
    processed_at: row.processed_at ? new Date(row.processed_at) : null,
  };
}

/** Build a canonical payload hash from the business fields only (no transport metadata). */
export function wagerPayloadHash(input: {
  kind: string;
  money: MoneyProps;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  externalTransactionId: string;
  providerId: string;
  referenceExternalTransactionId?: string | undefined;
}): string {
  return payloadHash({
    kind: input.kind,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    externalTransactionId: input.externalTransactionId,
    providerId: input.providerId,
    money: input.money,
    ...(input.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
      : {}),
  });
}
