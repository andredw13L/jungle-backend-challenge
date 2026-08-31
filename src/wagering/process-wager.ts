import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { MIKRO_ORM } from '../infrastructure/database/entities';
import type { AppOrm } from '../infrastructure/database/orm.module';
import { InsufficientFundsError, WagerInfrastructureError } from '../domain/errors';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { v7 as uuidv7 } from 'uuid';
import type {
  NormalizedWagerInput,
  PersistedWagerResponse,
  SubmitWagerInput,
  SubmitWagerResult,
} from './process-wager.types';
import { WagerRepository, type WagerRow, type WalletRow, wagerPayloadHash } from './wager.repository';

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
    @Inject(MIKRO_ORM) private readonly orm: Promise<AppOrm>,
    readonly repo: WagerRepository,
  ) {}

  async execute(input: SubmitWagerInput): Promise<SubmitWagerResult> {
    const normalized = normalizeWagerInput(input);
    const payloadHash = wagerPayloadHash(normalized);
    const txId = uuidv7();

    try {
      const orm = await this.orm;
      return await orm.em.fork().transactional(async (em) => {
        // Insert-first arbitrates concurrent attempts: PostgreSQL blocks
        // any duplicate INSERT on `uq_wager_idempotency_key` until the
        // winner commits, then raises 23505. We catch that and route to
        // the replay path. The same race can hit `uq_wager_provider_external`
        // first when two concurrent calls share the same
        // (providerId, externalTransactionId) — same fix.
        await this.repo.insertPending(em, {
          id: txId,
          type: normalized.kind,
          walletId: normalized.walletId,
          playerId: normalized.playerId,
          roundId: normalized.roundId,
          gameId: normalized.gameId,
          providerId: normalized.providerId,
          externalTransactionId: normalized.externalTransactionId,
          amount: normalized.money,
          referenceExternalTransactionId: normalized.referenceExternalTransactionId,
          payloadHash,
          idempotencyKey: normalized.idempotencyKey,
        });

        if (normalized.kind === 'LOSS') {
          return await this.processLoss(em, normalized, txId, normalized.walletId);
        }
        if (normalized.kind === 'REFUND' || normalized.kind === 'ROLLBACK') {
          return await this.processReversal(em, normalized, txId);
        }
        return await this.processBalanceChange(em, normalized, txId, normalized.walletId);
      }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    } catch (err) {
      if (isUniqueViolation(err, 'uq_wager_idempotency_key')) {
        return await this.replayFromPersisted(normalized, payloadHash);
      }
      if (isUniqueViolation(err, 'uq_wager_provider_external')) {
        throw new UnprocessableEntityException({
          code: 'EXTERNAL_TRANSACTION_CONFLICT',
          message: 'provider transaction was already used',
        });
      }
      if (isForeignKeyViolation(err, 'wager_transactions_wallet_id_fkey')) {
        throw new UnprocessableEntityException({
          code: 'WALLET_NOT_FOUND',
          message: `wallet ${normalized.walletId} was not found`,
        });
      }
      if (isTransientPostgresError(err)) {
        throw new WagerInfrastructureError(err);
      }
      throw err;
    }
  }

  /**
   * Read the persisted row after losing the INSERT race. Runs in a
   * fresh transaction (the original was rolled back) so we see the
   * committed winner's `response_payload`.
   */
  private async replayFromPersisted(
    input: NormalizedWagerInput,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const em = (await this.orm).em.fork();
    const r = await em.execute<{ payload_hash: string; response_payload: Record<string, unknown> | null }[]>(
      `SELECT payload_hash, response_payload
       FROM wager_transactions WHERE idempotency_key = ?`,
      [input.idempotencyKey],
    );
    const row = r[0];
    if (!row || !row.response_payload) {
      throw new Error('race winner row missing — aborting');
    }
    if (row.payload_hash !== payloadHash) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'idempotency key reused with a different payload',
      });
    }
    const persisted = normalizePersistedResponse(row.response_payload as unknown as PersistedWagerResponse);
    return makeResult(persisted, true);
  }

  /**
   * LOSS — no wallet mutation, no Ledger entry. Just persist the
   * wager transaction and enqueue `WagerTransactionProcessed`.
   */
  private async processLoss(
    em: PostgreSqlEntityManager,
    input: NormalizedWagerInput,
    txId: string,
    walletId: string,
  ): Promise<SubmitWagerResult> {
    const wallet = await em.execute<{ id: string }[]>(
      `SELECT id FROM wallets WHERE id = ? AND player_id = ? AND currency = ?`,
      [walletId, input.playerId, input.money.currency],
    );
    if (!wallet[0]) {
      throw new UnprocessableEntityException({
        code: 'WALLET_NOT_FOUND',
        message: `no wallet for player ${input.playerId} in ${input.money.currency}`,
      });
    }
    const response: PersistedWagerResponse = {
      transactionId: txId,
      status: 'PROCESSED',
    };
    await this.repo.markProcessed(em, txId, response as unknown as Record<string, unknown>);
    await this.repo.insertOutboxEvent(em, new WagerTransactionProcessed(
      uuidv7(),
      new Date(),
      input.correlationId,
      {
        wagerTransactionId: txId,
        walletId,
        type: 'LOSS',
        status: 'PROCESSED',
        amount: input.money,
      },
    ));
    return makeResult(response, false);
  }

  /**
   * BET / WIN — lock the wallet, apply the domain transition, persist
   * the wallet update + Ledger entry + wager status + outbox event in
   * the same transaction.
   */
  private async processBalanceChange(
    em: PostgreSqlEntityManager,
    input: NormalizedWagerInput,
    txId: string,
    walletId: string,
  ): Promise<SubmitWagerResult> {
    const walletRow = await this.repo.lockWallet(em, walletId, input.playerId, input.money.currency);
    if (!walletRow) {
      throw new UnprocessableEntityException({
        code: 'WALLET_NOT_FOUND',
        message: `no wallet for player ${input.playerId} in ${input.money.currency}`,
      });
    }

    if (input.kind === 'WIN' && input.referenceExternalTransactionId) {
      const reference = await this.repo.findReferenceByProviderExternal(
        em,
        input.providerId,
        input.referenceExternalTransactionId,
      );
      const validReference = reference?.status === 'PROCESSED' &&
        reference.type === 'BET' &&
        reference.provider_id === input.providerId &&
        reference.wallet_id === walletRow.id &&
        reference.player_id === input.playerId &&
        reference.round_id === input.roundId &&
        reference.amount_currency === input.money.currency;
      if (!validReference) {
        const response: PersistedWagerResponse = {
          transactionId: txId,
          status: 'REJECTED',
          failureCode: 'REFERENCE_MISMATCH',
        };
        await this.repo.markRejected(em, txId, 'REFERENCE_MISMATCH', response as unknown as Record<string, unknown>);
        await this.repo.insertOutboxEvent(em, new WagerTransactionRejected(
          uuidv7(),
          new Date(),
          input.correlationId,
          {
            wagerTransactionId: txId,
            walletId: walletRow.id,
            type: input.kind,
            status: 'REJECTED',
            amount: input.money,
            failureCode: 'REFERENCE_MISMATCH',
          },
        ));
        return makeResult(response, false);
      }
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
    const value = Money.create(input.money);

    try {
      const applyResult =
        input.kind === 'BET'
          ? wallet.debit(value, txId, new Date())
          : wallet.credit(value, txId, new Date());

      await this.repo.applyWalletMutation(
        em,
        walletRow.id,
        applyResult.wallet.snapshot.balance.amount,
      );
      await this.repo.insertLedgerEntry(em, {
        direction: input.kind === 'BET' ? 'DEBIT' : 'CREDIT',
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
        transactionId: txId,
        status: 'PROCESSED',
        balance: applyResult.wallet.snapshot.balance.toJSON(),
      };
      await this.repo.markProcessed(em, txId, response as unknown as Record<string, unknown>);
      await this.repo.insertOutboxEvent(em, new WalletBalanceChanged(
        uuidv7(),
        new Date(),
        input.correlationId,
        {
          walletId: walletRow.id,
          playerId: input.playerId,
          currency: input.money.currency,
          walletVersion: applyResult.wallet.snapshot.version,
          direction: input.kind === 'BET' ? 'DEBIT' : 'CREDIT',
          value: input.money,
          balanceBefore: {
            amount: applyResult.entry.props.balanceBefore.amount,
            currency: applyResult.entry.props.balanceBefore.currency,
          },
          balanceAfter: {
            amount: applyResult.entry.props.balanceAfter.amount,
            currency: applyResult.entry.props.balanceAfter.currency,
          },
          transactionId: txId,
        },
      ));
      await this.repo.insertOutboxEvent(em, new WagerTransactionProcessed(
        uuidv7(),
        new Date(),
        input.correlationId,
        {
          wagerTransactionId: txId,
          walletId: walletRow.id,
          type: input.kind,
          status: 'PROCESSED',
          amount: input.money,
        },
      ));
      return makeResult(response, false, {
        id: applyResult.wallet.snapshot.id,
        balance: applyResult.wallet.snapshot.balance.toJSON(),
        version: applyResult.wallet.snapshot.version,
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        const response: PersistedWagerResponse = {
          transactionId: txId,
          status: 'REJECTED',
          failureCode: 'INSUFFICIENT_FUNDS',
        };
        await this.repo.markRejected(em, txId, 'INSUFFICIENT_FUNDS', response as unknown as Record<string, unknown>);
        await this.repo.insertOutboxEvent(em, new WagerTransactionRejected(
          uuidv7(),
          new Date(),
          input.correlationId,
          {
            wagerTransactionId: txId,
            walletId: walletRow.id,
            type: input.kind,
            status: 'REJECTED',
            amount: input.money,
            failureCode: 'INSUFFICIENT_FUNDS',
          },
        ));
        return makeResult(response, false);
      }
      throw err;
    }
  }

  /** REFUND/ROLLBACK resolve the public reference while holding Wallet first. */
  async resolveReversal(
    em: PostgreSqlEntityManager,
    input: NormalizedWagerInput,
  ): Promise<{ walletRow: WalletRow | null; referenceRow: WagerRow | null; providerMismatch: boolean }> {
    const walletRow = await this.repo.lockWalletById(em, input.walletId);
    if (!walletRow) return { walletRow: null, referenceRow: null, providerMismatch: false };
    if (input.referenceExternalTransactionId === undefined) {
      return { walletRow, referenceRow: null, providerMismatch: false };
    }
    const referenceRow = await this.repo.findReferenceByProviderExternal(
      em,
      input.providerId,
      input.referenceExternalTransactionId,
    );
    if (referenceRow) return { walletRow, referenceRow, providerMismatch: false };
    const otherProviderRow = await this.repo.findReferenceByExternal(
      em,
      input.referenceExternalTransactionId,
    );
    return {
      walletRow,
      referenceRow: otherProviderRow,
      providerMismatch: otherProviderRow !== null,
    };
  }

  private async processReversal(
    em: PostgreSqlEntityManager,
    input: NormalizedWagerInput,
    txId: string,
  ): Promise<SubmitWagerResult> {
    if (!input.referenceExternalTransactionId) {
      throw new UnprocessableEntityException({
        code: 'REFERENCE_REQUIRED',
        message: 'REFUND and ROLLBACK require a referenceExternalTransactionId',
      });
    }
    const { walletRow, referenceRow, providerMismatch } = await this.resolveReversal(em, input);
    if (!walletRow) {
      throw new UnprocessableEntityException({
        code: 'WALLET_NOT_FOUND',
        message: `wallet ${input.walletId} was not found`,
      });
    }
    if (!referenceRow || (!providerMismatch && referenceRow.status !== 'PROCESSED')) {
      return this.markPendingReference(em, input, txId, walletRow.id);
    }
    return this.applyResolvedReversal(em, input, txId, walletRow, referenceRow);
  }

  /** The single transaction-bound reversal rule/effect path used by HTTP and worker. */
  async applyResolvedReversal(
    em: PostgreSqlEntityManager,
    input: NormalizedWagerInput,
    txId: string,
    walletRow: WalletRow,
    referenceRow: WagerRow,
  ): Promise<SubmitWagerResult> {
    const referenceTransactionId = referenceRow.id;
    const validRefType = input.kind === 'REFUND'
      ? referenceRow.type === 'BET'
      : referenceRow.type === 'BET' || referenceRow.type === 'WIN' || referenceRow.type === 'REFUND';
    const validScope =
      validRefType &&
      referenceRow.provider_id === input.providerId &&
      referenceRow.status === 'PROCESSED' &&
      referenceRow.player_id === input.playerId &&
      referenceRow.wallet_id === walletRow.id &&
      walletRow.player_id === input.playerId &&
      walletRow.currency === input.money.currency &&
      referenceRow.round_id === input.roundId &&
      referenceRow.amount_amount === input.money.amount &&
      referenceRow.amount_currency === input.money.currency;
    if (!validScope) {
      // A malformed scope must not reserve the reference/type pair; a
      // corrected command should still be able to reverse it.
      return this.rejectReversal(em, input, txId, walletRow.id, 'REFERENCE_MISMATCH');
    }

    const duplicate = await this.repo.findReversalByReferenceType(
      em,
      referenceTransactionId,
      input.kind as 'REFUND' | 'ROLLBACK',
      txId,
    );
    if (duplicate) {
      // The partial unique index reserves the reference for the winner; the
      // loser remains auditable with its public external reference only.
      return this.rejectReversal(em, input, txId, walletRow.id, 'REFERENCE_ALREADY_REVERSED');
    }

    const direction: 'DEBIT' | 'CREDIT' =
      input.kind === 'REFUND' || (input.kind === 'ROLLBACK' && referenceRow.type === 'BET')
        ? 'CREDIT'
        : 'DEBIT';
    const value = Money.create(input.money);
    const wallet = Wallet.rehydrate({
      id: walletRow.id,
      playerId: walletRow.player_id,
      currency: walletRow.currency,
      balance: Money.create({ amount: String(walletRow.balance_amount), currency: walletRow.balance_currency }),
      version: walletRow.version,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    try {
      const apply = direction === 'DEBIT'
        ? wallet.debit(value, txId, new Date())
        : wallet.credit(value, txId, new Date());
      await this.repo.applyWalletMutation(em, walletRow.id, apply.wallet.snapshot.balance.amount);
      await this.repo.insertLedgerEntry(em, {
        direction,
        valueAmount: value.amount,
        valueCurrency: value.currency,
        balanceBeforeAmount: apply.entry.props.balanceBefore.amount,
        balanceBeforeCurrency: apply.entry.props.balanceBefore.currency,
        balanceAfterAmount: apply.entry.props.balanceAfter.amount,
        balanceAfterCurrency: apply.entry.props.balanceAfter.currency,
        walletId: walletRow.id,
        transactionId: txId,
      });
      await this.repo.setReference(em, txId, referenceTransactionId);
      const response: PersistedWagerResponse = {
        transactionId: txId,
        status: 'PROCESSED',
        referenceTransactionId,
        referenceExternalTransactionId: input.referenceExternalTransactionId!,
        balance: apply.wallet.snapshot.balance.toJSON(),
      };
      await this.repo.markProcessed(em, txId, response as unknown as Record<string, unknown>);
      await this.repo.insertOutboxEvent(em, new WalletBalanceChanged(
        uuidv7(), new Date(), input.correlationId, {
          walletId: walletRow.id,
          playerId: input.playerId,
          currency: input.money.currency,
          walletVersion: apply.wallet.snapshot.version,
          direction,
          value: input.money,
          balanceBefore: apply.entry.props.balanceBefore.toJSON(),
          balanceAfter: apply.entry.props.balanceAfter.toJSON(),
          transactionId: txId,
        },
      ));
      await this.repo.insertOutboxEvent(em, new WagerTransactionProcessed(
        uuidv7(), new Date(), input.correlationId, {
          wagerTransactionId: txId,
          walletId: walletRow.id,
          type: input.kind,
          status: 'PROCESSED',
          amount: input.money,
          referenceTransactionId,
          referenceExternalTransactionId: input.referenceExternalTransactionId!,
        },
      ));
      return makeResult(response, false, {
        id: apply.wallet.snapshot.id,
        balance: apply.wallet.snapshot.balance.toJSON(),
        version: apply.wallet.snapshot.version,
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return this.rejectReversal(em, input, txId, walletRow.id, 'REVERSAL_WOULD_OVERDRAW');
      }
      throw err;
    }
  }

  async rejectReversal(
    em: PostgreSqlEntityManager,
    input: NormalizedWagerInput,
    txId: string,
    walletId: string,
    code: string,
    referenceTransactionId?: string,
    referenceAttempts?: number,
  ): Promise<SubmitWagerResult> {
    if (referenceTransactionId) await this.repo.setReference(em, txId, referenceTransactionId);
    const response: PersistedWagerResponse = {
      transactionId: txId,
      status: 'REJECTED',
      failureCode: code,
      ...(referenceTransactionId ? { referenceTransactionId } : {}),
      ...(input.referenceExternalTransactionId ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
    };
    await this.repo.markRejected(em, txId, code, response as unknown as Record<string, unknown>, referenceAttempts);
    await this.repo.insertOutboxEvent(em, new WagerTransactionRejected(
      uuidv7(), new Date(), input.correlationId, {
        wagerTransactionId: txId,
        walletId,
        type: input.kind,
        status: 'REJECTED',
        amount: input.money,
        ...(referenceTransactionId ? { referenceTransactionId } : {}),
        ...(input.referenceExternalTransactionId ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
        failureCode: code,
      },
    ));
    return makeResult(response, false);
  }

  private async markPendingReference(
    em: PostgreSqlEntityManager,
    input: NormalizedWagerInput,
    txId: string,
    walletId: string,
  ): Promise<SubmitWagerResult> {
    const response: PersistedWagerResponse = {
      transactionId: txId,
      status: 'PENDING',
      referenceExternalTransactionId: input.referenceExternalTransactionId!,
    };
    await this.repo.transitionToPendingReference(
      em,
      txId,
      new Date(Date.now() + 1000),
      1,
      response as unknown as Record<string, unknown>,
    );
    await this.repo.insertOutboxEvent(em, new WagerTransactionPendingReference(
      uuidv7(), new Date(), input.correlationId, {
        wagerTransactionId: txId,
        walletId,
        type: input.kind,
        status: 'PENDING_REFERENCE',
        amount: input.money,
        referenceExternalTransactionId: input.referenceExternalTransactionId!,
      },
    ));
    return makeResult(response, false);
  }
}

function normalizeWagerInput(input: SubmitWagerInput): NormalizedWagerInput {
  if (!input.walletId || !input.roundId || !input.gameId ||
    !['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(input.kind)) {
    throw new UnprocessableEntityException({ code: 'INVALID_PAYLOAD' });
  }
  let money: ReturnType<typeof Money.create>;
  try {
    money = Money.create(input.money);
  } catch {
    throw new UnprocessableEntityException({ code: 'INVALID_PAYLOAD' });
  }
  return {
    idempotencyKey: input.idempotencyKey,
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: money.toJSON(),
    ...(input.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
      : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

function normalizePersistedResponse(response: PersistedWagerResponse): PersistedWagerResponse {
  const transactionId = response.transactionId ?? response.wagerTransactionId;
  if (!transactionId) throw new Error('persisted wager response missing transactionId');
  return {
    transactionId,
    status: response.status,
    ...(response.failureCode !== undefined ? { failureCode: response.failureCode } : {}),
    ...(response.balance !== undefined
      ? { balance: response.balance }
      : response.wallet !== undefined
        ? { balance: response.wallet.balance }
        : {}),
    ...(response.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: response.referenceExternalTransactionId }
      : {}),
    ...(response.referenceTransactionId !== undefined
      ? { referenceTransactionId: response.referenceTransactionId }
      : {}),
  };
}

function makeResult(
  response: PersistedWagerResponse,
  idempotentReplay: boolean,
  wallet?: { id: string; balance: { amount: string; currency: string }; version: number },
): SubmitWagerResult {
  const result: SubmitWagerResult = { ...response, idempotentReplay };
  Object.defineProperty(result, 'wagerTransactionId', {
    value: response.transactionId,
    enumerable: false,
  });
  if (wallet) Object.defineProperty(result, 'wallet', { value: wallet, enumerable: false });
  return result;
}

function isTransientPostgresError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as { code?: string; sqlState?: string; cause?: unknown; message?: string };
  const sqlState = error.code ?? error.sqlState;
  if (sqlState && ['40001', '08000', '08003', '08006', '57P01', '57P03'].includes(sqlState)) return true;
  if (error.cause && isTransientPostgresError(error.cause)) return true;
  return typeof error.message === 'string' &&
    /ECONNRESET|ECONNREFUSED|connection terminated/i.test(error.message);
}

function isForeignKeyViolation(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as { code?: string; constraint?: string; message?: string };
  return error.code === '23503' &&
    (error.constraint === constraint || error.message?.includes(constraint) === true);
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
