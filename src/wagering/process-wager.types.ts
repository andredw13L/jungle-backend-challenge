import type { MoneyProps } from '../domain/money';

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerType = WagerKind;

/** Canonical business command shared by HTTP and the command consumer. */
export type SubmitWagerInput = {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId?: string;
};

export type NormalizedWagerInput = SubmitWagerInput;

export type WagerResultStatus = 'PROCESSED' | 'REJECTED' | 'PENDING';

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerResultStatus;
  failureCode?: string;
  balance?: MoneyProps;
  wallet?: { id: string; balance: MoneyProps; version: number };
  idempotentReplay: boolean;
  /** Non-enumerable compatibility alias for pre-Task 3 direct callers. */
  readonly wagerTransactionId?: string;
}

export interface PersistedWagerResponse {
  transactionId: string;
  status: WagerResultStatus;
  failureCode?: string;
  balance?: MoneyProps;
  wallet?: { id: string; balance: MoneyProps; version: number };
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  /** Non-enumerable compatibility alias for the Task 4 worker. */
  readonly wagerTransactionId?: string;
}
