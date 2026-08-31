import {
  InvalidWagerError,
  InvalidWagerTransitionError,
} from './errors';
import { Money } from './money';

export type WagerType =
  | 'OPENING'
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

export type WagerStatus = 'PENDING' | 'PROCESSED' | 'REJECTED' | 'FAILED';

export interface WagerTransactionSnapshot {
  id: string;
  type: WagerType;
  status: WagerStatus;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  amount: Money;
  reference?: string;
  payloadHash: string;
  responsePayload?: string;
  failureCode?: string;
  referenceAttempts: number;
  nextRetryAt?: Date;
  createdAt: Date;
  processedAt?: Date;
}

/**
 * WagerTransaction — state machine for a single wager operation.
 *
 * - OPENING is reserved for the internal wallet opening; external create
 *   rejects it.
 * - REFUND / ROLLBACK require a `reference` pointing at the wager they
 *   reverse (slice 6 enforces identity/scope/value).
 * - Terminal states (PROCESSED, REJECTED, FAILED) cannot transition further.
 * - LOSS / REJECTED do not touch the Wallet — see `wallet.ts`.
 *
 * `create()` validates and starts the transaction in PENDING. The
 * persistence layer (slice 3+) calls `markProcessed` / `markRejected` /
 * `markFailed` to advance the state machine.
 */
export class WagerTransaction {
  private constructor(
    public readonly snapshot: WagerTransactionSnapshot,
  ) {}

  static create(props: {
    id: string;
    type: WagerType;
    walletId: string;
    providerId: string;
    externalTransactionId: string;
    amount: Money;
    reference?: string;
    payloadHash: string;
    createdAt: Date;
  }): WagerTransaction {
    if (props.type === 'OPENING') {
      throw new InvalidWagerError('OPENING cannot be created externally');
    }
    if (
      (props.type === 'REFUND' || props.type === 'ROLLBACK') &&
      !props.reference
    ) {
      throw new InvalidWagerError(
        `${props.type} requires a reference to the wager it reverses`,
      );
    }
    // ponytail: exactOptionalPropertyTypes rejects `reference: undefined`
    // when the field is declared `reference?: string`. Build the snapshot
    // conditionally so we either set the value or omit the key entirely.
    const snapshot: WagerTransactionSnapshot = Object.freeze({
      id: props.id,
      type: props.type,
      status: 'PENDING',
      walletId: props.walletId,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      amount: props.amount,
      payloadHash: props.payloadHash,
      referenceAttempts: 0,
      createdAt: props.createdAt,
      ...(props.reference !== undefined ? { reference: props.reference } : {}),
    });
    return Object.freeze(new WagerTransaction(snapshot)) as WagerTransaction;
  }

  /**
   * Internal factory for the wallet opening. The transaction is created in
   * PROCESSED state because the opening is committed atomically with the
   * wallet — there is no async processing path.
   */
  static createOpening(props: {
    id: string;
    walletId: string;
    amount: Money;
    openedAt: Date;
  }): WagerTransaction {
    const snapshot: WagerTransactionSnapshot = Object.freeze({
      id: props.id,
      type: 'OPENING',
      status: 'PROCESSED',
      walletId: props.walletId,
      providerId: '',
      externalTransactionId: '',
      amount: props.amount,
      payloadHash: '',
      referenceAttempts: 0,
      createdAt: props.openedAt,
      processedAt: props.openedAt,
    });
    return Object.freeze(new WagerTransaction(snapshot)) as WagerTransaction;
  }

  static rehydrate(props: WagerTransactionSnapshot): WagerTransaction {
    return Object.freeze(
      new WagerTransaction(Object.freeze({ ...props })),
    ) as WagerTransaction;
  }

  markProcessed(responsePayload: string, at: Date): WagerTransaction {
    this.assertTransition('PROCESSED');
    return this.with({
      status: 'PROCESSED',
      responsePayload,
      processedAt: at,
    });
  }

  markRejected(
    failureCode: string,
    responsePayload: string,
    at: Date,
  ): WagerTransaction {
    this.assertTransition('REJECTED');
    return this.with({
      status: 'REJECTED',
      failureCode,
      responsePayload,
      processedAt: at,
    });
  }

  markFailed(failureCode: string, at: Date): WagerTransaction {
    this.assertTransition('FAILED');
    return this.with({ status: 'FAILED', failureCode, processedAt: at });
  }

  /** Schedule a retry for a PENDING reversal waiting on its reference. */
  scheduleReferenceRetry(
    nextRetryAt: Date,
    attempt: number,
  ): WagerTransaction {
    if (this.snapshot.status !== 'PENDING') {
      throw new InvalidWagerTransitionError(this.snapshot.status, 'PENDING');
    }
    return this.with({ nextRetryAt, referenceAttempts: attempt });
  }

  private with(overrides: Partial<WagerTransactionSnapshot>): WagerTransaction {
    return Object.freeze(
      new WagerTransaction(
        Object.freeze({ ...this.snapshot, ...overrides }),
      ),
    ) as WagerTransaction;
  }

  private assertTransition(next: WagerStatus): void {
    if (this.snapshot.status !== 'PENDING') {
      throw new InvalidWagerTransitionError(this.snapshot.status, next);
    }
  }
}