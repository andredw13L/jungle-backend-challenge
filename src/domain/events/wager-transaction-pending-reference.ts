import type { WagerTransactionProcessedPayload } from './wager-transaction-processed';
import { IntegrationEvent } from './integration-event';

export type WagerTransactionPendingReferencePayload = WagerTransactionProcessedPayload & {
  status: 'PENDING_REFERENCE';
  referenceExternalTransactionId: string;
};

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferencePayload> {
  readonly eventType = 'WagerTransactionPendingReference' as const;
  readonly version = 1 as const;

  constructor(
    eventId: string,
    occurredAt: Date,
    correlationId: string | undefined,
    public readonly payload: WagerTransactionPendingReferencePayload,
  ) {
    super(eventId, occurredAt, correlationId, payload.wagerTransactionId, payload);
    Object.freeze(this);
  }
}
