import type { WagerTransactionProcessedPayload } from './wager-transaction-processed';
import { IntegrationEvent } from './integration-event';

export type WagerTransactionRejectedPayload = WagerTransactionProcessedPayload & {
  failureCode: string;
};

/** A business rejection is distinct from a successfully processed wager. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedPayload> {
  readonly eventType = 'WagerTransactionRejected' as const;
  readonly version = 1 as const;

  constructor(
    eventId: string,
    occurredAt: Date,
    correlationId: string | undefined,
    public readonly payload: WagerTransactionRejectedPayload,
  ) {
    super(eventId, occurredAt, correlationId, payload.wagerTransactionId, payload);
    Object.freeze(this);
  }
}
