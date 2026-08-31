import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Thin wrapper over prom-client. Keeps one registry for process metrics, the
 * reconciliation divergence counter used by the wallet read path, the
 * command-consumer counters (slice 7): inbox outcomes, DLQ redirects,
 * in-flight gauge, and processing latency; and the outbox/wallet metrics
 * (slice 8): outbox lag gauge, wallet lock conflicts, and the
 * published/failure observability counters.
 */
@Injectable()
export class MetricsService {
  readonly registry: Registry;
  readonly reconciliationDivergences: Counter<string>;
  readonly inboxReceived: Counter<string>;
  readonly consumerDlq: Counter<string>;
  readonly consumerInflight: Gauge<string>;
  readonly consumerProcessingSeconds: Histogram<string>;
  readonly outboxLag: Gauge<string>;
  readonly walletLockConflicts: Counter<string>;
  readonly outboxPublished: Counter<string>;
  readonly outboxPublishFailures: Counter<string>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });
    this.reconciliationDivergences = new Counter({
      name: 'wallet_reconciliation_divergences_total',
      help: 'Wallet reconciliation calls that found a balance divergence',
      registers: [this.registry],
    });
    this.inboxReceived = new Counter({
      name: 'consumer_inbox_received_total',
      help: 'SQS command messages classified by outcome (processed|rejected|duplicate|dlq|retried)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.consumerDlq = new Counter({
      name: 'consumer_dlq_total',
      help: 'Messages redirected to the DLQ after exceeding CONSUMER_DLQ_MAX_RECEIVES',
      registers: [this.registry],
    });
    this.consumerInflight = new Gauge({
      name: 'consumer_inflight',
      help: 'Messages currently being processed by the command consumer',
      registers: [this.registry],
    });
    this.consumerProcessingSeconds = new Histogram({
      name: 'consumer_processing_seconds',
      help: 'Per-message processing latency (seconds)',
      registers: [this.registry],
    });
    this.outboxLag = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Seconds since the oldest PENDING outbox event was created',
      registers: [this.registry],
    });
    this.walletLockConflicts = new Counter({
      name: 'wallet_lock_conflicts_total',
      help: 'Wallet FOR UPDATE lock attempts that failed (55P03/NOWAIT/deadlock)',
      registers: [this.registry],
    });
    this.outboxPublished = new Counter({
      name: 'outbox_published_total',
      help: 'Outbox events confirmed published to wager-events.fifo',
      labelNames: ['event_type'],
      registers: [this.registry],
    });
    this.outboxPublishFailures = new Counter({
      name: 'outbox_publish_failures_total',
      help: 'Outbox SendMessage failures by reason (network|throttle|permanent)',
      labelNames: ['reason'],
      registers: [this.registry],
    });
  }

  recordReconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }

  recordInboxReceived(outcome: string): void {
    this.inboxReceived.inc({ outcome });
  }

  recordConsumerDlq(): void {
    this.consumerDlq.inc();
  }

  setConsumerInflight(count: number): void {
    this.consumerInflight.set(count);
  }

  observeConsumerProcessing(seconds: number): void {
    this.consumerProcessingSeconds.observe(seconds);
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag.set(seconds);
  }

  recordWalletLockConflict(): void {
    this.walletLockConflicts.inc();
  }

  recordOutboxPublished(eventType: string): void {
    this.outboxPublished.inc({ event_type: eventType });
  }

  recordOutboxPublishFailure(reason: string): void {
    this.outboxPublishFailures.inc({ reason });
  }

  contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
