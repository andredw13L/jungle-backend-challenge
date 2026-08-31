import { IntegrationEvent } from './integration-event';

export type BalanceDirection = 'CREDIT' | 'DEBIT';

export interface WalletBalanceChangedPayload {
  walletId: string;
  playerId: string;
  currency: string;
  walletVersion: number;
  direction: BalanceDirection;
  value: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  transactionId: string;
}

/**
 * WalletBalanceChanged — emitted whenever a wallet's balance moves.
 * `walletVersion` increments by exactly one per emission; consumers can use
 * it to detect missed events.
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedPayload> {
  readonly eventType = 'WalletBalanceChanged' as const;
  readonly version = 1 as const;

  constructor(
    eventId: string,
    occurredAt: Date,
    correlationId: string | undefined,
    public readonly payload: WalletBalanceChangedPayload,
  ) {
    super(eventId, occurredAt, correlationId, payload.walletId, payload);
    // ponytail: freeze after the subclass fields are assigned — freezing
    // inside `super()` blocks field initialisation.
    Object.freeze(this);
  }

  toJSON(): Record<string, unknown> {
    return super.toJSON();
  }
}
