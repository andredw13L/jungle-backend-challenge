import { Inject, Injectable } from '@nestjs/common';
import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { MIKRO_ORM } from '../infrastructure/database/entities';
import type { AppOrm } from '../infrastructure/database/orm.module';
import { ProcessWager } from './process-wager';
import type { NormalizedWagerInput } from './process-wager.types';
import type { WagerRow } from './wager.repository';

/** Retries one due pending-reference row per READ COMMITTED transaction. */
@Injectable()
export class PendingReferenceWorker {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: Promise<AppOrm>,
    private readonly process: ProcessWager,
  ) {}

  async processBatch(options: {
    maxAttempts?: number;
    baseSeconds?: number;
    maxSeconds?: number;
    batchSize?: number;
  } = {}): Promise<{ resolved: number; rejected: number; rescheduled: number }> {
    const cfg = {
      maxAttempts: options.maxAttempts ?? 8,
      baseSeconds: options.baseSeconds ?? 1,
      maxSeconds: options.maxSeconds ?? 60,
    };
    const batchSize = options.batchSize ?? 10;
    const orm = await this.orm;
    let resolved = 0;
    let rejected = 0;
    let rescheduled = 0;

    while (resolved + rejected + rescheduled < batchSize) {
      const outcome = await orm.em.fork().transactional(async (em) => {
        const row = (await this.process.repo.findPendingReferences(em, 1))[0];
        return row ? this.processOne(em, row, cfg) : null;
      }, { isolationLevel: IsolationLevel.READ_COMMITTED });
      if (!outcome) break;
      if (outcome === 'resolved') resolved++;
      else if (outcome === 'rejected') rejected++;
      else rescheduled++;
    }
    return { resolved, rejected, rescheduled };
  }

  private async processOne(
    em: PostgreSqlEntityManager,
    row: WagerRow,
    cfg: { maxAttempts: number; baseSeconds: number; maxSeconds: number },
  ): Promise<'resolved' | 'rejected' | 'rescheduled'> {
    const input = inputFromRow(row);
    if (!input.referenceExternalTransactionId) {
      await this.process.rejectReversal(em, input, row.id, row.wallet_id, 'REFERENCE_NOT_FOUND', undefined, cfg.maxAttempts);
      return 'rejected';
    }

    const { walletRow, referenceRow, providerMismatch } = await this.process.resolveReversal(em, input);
    if (!walletRow) {
      await this.process.rejectReversal(em, input, row.id, row.wallet_id, 'WALLET_NOT_FOUND', undefined, cfg.maxAttempts);
      return 'rejected';
    }
    if (providerMismatch) {
      await this.process.applyResolvedReversal(em, input, row.id, walletRow, referenceRow!);
      return 'rejected';
    }
    if (!referenceRow || referenceRow.status !== 'PROCESSED') {
      if (row.reference_attempts >= cfg.maxAttempts) {
        await this.process.rejectReversal(em, input, row.id, walletRow.id, 'REFERENCE_NOT_FOUND', undefined, cfg.maxAttempts);
        return 'rejected';
      }
      const nextAttempt = row.reference_attempts + 1;
      const delaySeconds = Math.min(
        cfg.baseSeconds * 2 ** (nextAttempt - 1),
        cfg.maxSeconds,
      );
      await this.process.repo.updatePendingRetry(
        em,
        row.id,
        new Date(Date.now() + delaySeconds * 1000),
        nextAttempt,
      );
      return 'rescheduled';
    }

    const result = await this.process.applyResolvedReversal(
      em,
      input,
      row.id,
      walletRow,
      referenceRow,
    );
    return result.status === 'PROCESSED' ? 'resolved' : 'rejected';
  }
}

function inputFromRow(row: WagerRow): NormalizedWagerInput {
  return {
    idempotencyKey: `pending-reference:${row.id}`,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    playerId: row.player_id ?? '',
    walletId: row.wallet_id,
    roundId: row.round_id ?? '',
    gameId: row.game_id ?? '',
    kind: row.type as 'REFUND' | 'ROLLBACK',
    money: { amount: String(row.amount_amount), currency: row.amount_currency },
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
  };
}
