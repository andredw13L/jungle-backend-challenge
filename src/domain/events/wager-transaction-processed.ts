import type { WagerStatus, WagerType } from '../wager-transaction';
import { IntegrationEvent } from './integration-event';

export interface WagerTransactionProcessedPayload {
  wagerTransactionId: string;
  walletId: string;
  type: WagerType;
  status: WagerStatus | 'PENDING_REFERENCE';
  amount: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
}

/**
 * WagerTransactionProcessed — emitted exactly once per wager reaching a
 * terminal state. LOSS/REJECTED wagers still emit this; the
 * WalletBalanceChanged event is emitted only when a balance actually moved.
 */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedPayload> {
  readonly eventType = 'WagerTransactionProcessed' as const;
  readonly version = 1 as const;

  constructor(
    eventId: string,
    occurredAt: Date,
    correlationId: string | undefined,
    public readonly payload: WagerTransactionProcessedPayload,
  ) {
    super(eventId, occurredAt, correlationId, payload.wagerTransactionId, payload);
    Object.freeze(this);
  }

  toJSON(): Record<string, unknown> {
    return super.toJSON();
  }
}
