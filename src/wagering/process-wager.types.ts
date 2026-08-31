import type { MoneyProps } from '../domain/money';

export type WagerType = 'BET' | 'WIN' | 'LOSS';

export interface SubmitWagerInput {
  idempotencyKey: string;
  type: WagerType;
  playerId: string;
  currency: string;
  amount: MoneyProps;
  externalTransactionId: string;
  providerId: string;
  correlationId?: string;
}

export type WagerResultStatus = 'PROCESSED' | 'REJECTED';

export interface SubmitWagerResult {
  wagerTransactionId: string;
  status: WagerResultStatus;
  failureCode?: string;
  wallet?: { id: string; balance: MoneyProps; version: number };
  idempotentReplay: boolean;
}

export interface PersistedWagerResponse {
  wagerTransactionId: string;
  status: WagerResultStatus;
  failureCode?: string;
  wallet?: { id: string; balance: MoneyProps; version: number };
}