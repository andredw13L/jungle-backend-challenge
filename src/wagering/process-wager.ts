import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../infrastructure/database/pool';
import { InsufficientFundsError } from '../domain/errors';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { v7 as uuidv7 } from 'uuid';
import type { PersistedWagerResponse, SubmitWagerInput, SubmitWagerResult } from './process-wager.types';
import { WagerRepository, wagerPayloadHash } from './wager.repository';

/**
 * ProcessWager — the deep module from the design. Same flow handles
 * HTTP and (in slice 7) SQS command-queue input. Idempotency is
 * arbitrated by `uq_wager_idempotency_key`; wallet contention is
 * serialised by `SELECT ... FOR UPDATE`. LOSS skips the wallet lock
 * because no balance changes.
 *
 * The business payload hash is computed from the *normalised* input
 * (after zod validation); transport metadata (correlation id, idempotency
 * key) is excluded — see ADR-0006.
 */
@Injectable()
export class ProcessWager {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly repo: WagerRepository,
  ) {}

  async execute(input: SubmitWagerInput): Promise<SubmitWagerResult> {
    const payloadHash = wagerPayloadHash(input);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");

      // Optimistic check: if the key already exists, replay or 422.
      const existing = await this.repo.findByIdempotencyKey(client, input.idempotencyKey);
      if (existing) {
        const replay = this.tryReplay(existing, payloadHash);
        if (replay) {
          await client.query('ROLLBACK');
          return { ...replay, idempotentReplay: true };
        }
        await client.query('ROLLBACK');
        throw new UnprocessableEntityException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'idempotency key reused with a different payload',
        });
      }

      // Insert-first arbitrates concurrent attempts: PostgreSQL blocks
      // any duplicate INSERT on `uq_wager_idempotency_key` until the
      // winner commits, then raises 23505. We catch that and route to
      // the replay path. The same race can hit `uq_wager_provider_external`
      // first when two concurrent calls share the same
      // (providerId, externalTransactionId) — same fix.
      if (input.type === 'LOSS') {
        return await this.processLoss(client, input, payloadHash);
      }
      return await this.processBalanceChange(client, input, payloadHash);
    } catch (err) {
      if (
        isUniqueViolation(err, 'uq_wager_idempotency_key') ||
        isUniqueViolation(err, 'uq_wager_provider_external')
      ) {
        await client.query('ROLLBACK').catch(() => undefined);
        return await this.replayFromPersisted(input, payloadHash);
      }
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Read the persisted row after losing the INSERT race. Runs in a
   * fresh transaction (the original was rolled back) so we see the
   * committed winner's `response_payload`.
   */
  private async replayFromPersisted(
    input: SubmitWagerInput,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const client = await this.pool.connect();
    try {
      const r = await client.query<{ payload_hash: string; response_payload: Record<string, unknown> | null }>(
        `SELECT payload_hash, response_payload
         FROM wager_transactions WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const row = r.rows[0];
      if (!row || !row.response_payload) {
        throw new Error('race winner row missing — aborting');
      }
      if (row.payload_hash !== payloadHash) {
        throw new UnprocessableEntityException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'idempotency key reused with a different payload',
        });
      }
      return { ...(row.response_payload as unknown as PersistedWagerResponse), idempotentReplay: true };
    } finally {
      client.release();
    }
  }

  /**
   * LOSS — no wallet mutation, no Ledger entry. Just persist the
   * wager transaction and enqueue `WagerTransactionProcessed`.
   */
  private async processLoss(
    client: import('pg').PoolClient,
    input: SubmitWagerInput,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const walletId = await this.resolveWalletId(client, input.playerId, input.currency);
    if (!walletId) {
      throw new UnprocessableEntityException({
        code: 'WALLET_NOT_FOUND',
        message: `no wallet for player ${input.playerId} in ${input.currency}`,
      });
    }
    const txId = uuidv7();
    await this.repo.insertPending(client, {
      id: txId,
      type: 'LOSS',
      walletId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      amount: input.amount,
      payloadHash,
      idempotencyKey: input.idempotencyKey,
    });
    const response: PersistedWagerResponse = {
      wagerTransactionId: txId,
      status: 'PROCESSED',
    };
    await this.repo.markProcessed(client, txId, response as unknown as Record<string, unknown>);
    await this.repo.insertOutboxEvent(client, {
      eventId: uuidv7(),
      eventType: 'WagerTransactionProcessed',
      payload: {
        wagerTransactionId: txId,
        walletId,
        type: 'LOSS',
        status: 'PROCESSED',
        amount: input.amount,
        correlationId: input.correlationId ?? null,
      },
    });
    await client.query('COMMIT');
    return { ...response, idempotentReplay: false };
  }

  /**
   * BET / WIN — lock the wallet, apply the domain transition, persist
   * the wallet update + Ledger entry + wager status + outbox event in
   * the same transaction.
   */
  private async processBalanceChange(
    client: import('pg').PoolClient,
    input: SubmitWagerInput,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const walletRow = await this.repo.lockWallet(client, input.playerId, input.currency);
    if (!walletRow) {
      throw new UnprocessableEntityException({
        code: 'WALLET_NOT_FOUND',
        message: `no wallet for player ${input.playerId} in ${input.currency}`,
      });
    }

    const wallet = Wallet.rehydrate({
      id: walletRow.id,
      playerId: walletRow.player_id,
      currency: walletRow.currency,
      balance: Money.create({
        amount: String(walletRow.balance_amount),
        currency: walletRow.balance_currency,
      }),
      version: walletRow.version,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const value = Money.create(input.amount);

    const txId = uuidv7();
    await this.repo.insertPending(client, {
      id: txId,
      type: input.type,
      walletId: walletRow.id,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      amount: input.amount,
      payloadHash,
      idempotencyKey: input.idempotencyKey,
    });

    try {
      const applyResult =
        input.type === 'BET'
          ? wallet.debit(value, txId, new Date())
          : wallet.credit(value, txId, new Date());

      await this.repo.applyWalletMutation(
        client,
        walletRow.id,
        applyResult.wallet.snapshot.balance.amount,
      );
      await this.repo.insertLedgerEntry(client, {
        direction: input.type === 'BET' ? 'DEBIT' : 'CREDIT',
        valueAmount: value.amount,
        valueCurrency: value.currency,
        balanceBeforeAmount: applyResult.entry.props.balanceBefore.amount,
        balanceBeforeCurrency: applyResult.entry.props.balanceBefore.currency,
        balanceAfterAmount: applyResult.entry.props.balanceAfter.amount,
        balanceAfterCurrency: applyResult.entry.props.balanceAfter.currency,
        walletId: walletRow.id,
        transactionId: txId,
      });

      const response: PersistedWagerResponse = {
        wagerTransactionId: txId,
        status: 'PROCESSED',
        wallet: {
          id: applyResult.wallet.snapshot.id,
          balance: {
            amount: applyResult.wallet.snapshot.balance.amount,
            currency: applyResult.wallet.snapshot.balance.currency,
          },
          version: applyResult.wallet.snapshot.version,
        },
      };
      await this.repo.markProcessed(client, txId, response as unknown as Record<string, unknown>);
      await this.repo.insertOutboxEvent(client, {
        eventId: uuidv7(),
        eventType: 'WalletBalanceChanged',
        payload: {
          walletId: walletRow.id,
          playerId: input.playerId,
          currency: input.currency,
          walletVersion: applyResult.wallet.snapshot.version,
          direction: input.type === 'BET' ? 'DEBIT' : 'CREDIT',
          value: input.amount,
          balanceBefore: {
            amount: applyResult.entry.props.balanceBefore.amount,
            currency: applyResult.entry.props.balanceBefore.currency,
          },
          balanceAfter: {
            amount: applyResult.entry.props.balanceAfter.amount,
            currency: applyResult.entry.props.balanceAfter.currency,
          },
          transactionId: txId,
          correlationId: input.correlationId ?? null,
        },
      });
      await this.repo.insertOutboxEvent(client, {
        eventId: uuidv7(),
        eventType: 'WagerTransactionProcessed',
        payload: {
          wagerTransactionId: txId,
          walletId: walletRow.id,
          type: input.type,
          status: 'PROCESSED',
          amount: input.amount,
          correlationId: input.correlationId ?? null,
        },
      });
      await client.query('COMMIT');
      return { ...response, idempotentReplay: false };
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        const response: PersistedWagerResponse = {
          wagerTransactionId: txId,
          status: 'REJECTED',
          failureCode: 'INSUFFICIENT_FUNDS',
        };
        await this.repo.markRejected(client, txId, 'INSUFFICIENT_FUNDS', response as unknown as Record<string, unknown>);
        await this.repo.insertOutboxEvent(client, {
          eventId: uuidv7(),
          eventType: 'WagerTransactionProcessed',
          payload: {
            wagerTransactionId: txId,
            walletId: walletRow.id,
            type: input.type,
            status: 'REJECTED',
            amount: input.amount,
            failureCode: 'INSUFFICIENT_FUNDS',
            correlationId: input.correlationId ?? null,
          },
        });
        await client.query('COMMIT');
        return { ...response, idempotentReplay: false };
      }
      throw err;
    }
  }

  /**
   * For LOSS we don't need a wallet lock, but we still need the
   * wallet id to set `wallet_id` on the wager row.
   */
  private async resolveWalletId(
    client: import('pg').PoolClient,
    playerId: string,
    currency: string,
  ): Promise<string | null> {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM wallets WHERE player_id = $1 AND currency = $2`,
      [playerId, currency],
    );
    return r.rows[0]?.id ?? null;
  }

  /**
   * When the idempotency key already exists, compare hashes. If they
   * match, return the persisted response (idempotent replay). If they
   * differ, the caller throws IDEMPOTENCY_CONFLICT.
   */
  private tryReplay(
    existing: { payload_hash: string; response_payload: Record<string, unknown> | null },
    payloadHash: string,
  ): PersistedWagerResponse | null {
    if (existing.payload_hash !== payloadHash) return null;
    const response = existing.response_payload as PersistedWagerResponse | null;
    if (!response || !response.wagerTransactionId) return null;
    return response;
  }
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code !== '23505') return false;
  return (
    e.constraint === constraint ||
    (typeof e.message === 'string' && e.message.includes(constraint))
  );
}