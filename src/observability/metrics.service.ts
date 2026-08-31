import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Registry } from 'prom-client';

/**
 * Thin wrapper over prom-client. Slice 1 only exposes the registry and the
 * default Node process metrics; the seven required counters/gauges/histograms
 * land in slice 8 alongside the Outbox/Inbox observability work.
 */
@Injectable()
export class MetricsService {
  readonly registry: Registry;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });
  }

  contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}