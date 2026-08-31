import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Registry } from 'prom-client';

/**
 * Thin wrapper over prom-client. Keeps one registry for process metrics and
 * the reconciliation divergence counter used by the wallet read path.
 */
@Injectable()
export class MetricsService {
  readonly registry: Registry;
  readonly reconciliationDivergences: Counter<string>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });
    this.reconciliationDivergences = new Counter({
      name: 'wallet_reconciliation_divergences_total',
      help: 'Wallet reconciliation calls that found a balance divergence',
      registers: [this.registry],
    });
  }

  recordReconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }

  contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
