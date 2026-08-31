import { describe, expect, test } from 'bun:test';
import { MetricsService } from './metrics.service';

describe('DLQ metric', () => {
  test('reports the broker-reported DLQ depth', async () => {
    const metrics = new MetricsService();
    metrics.setConsumerDlqDepth(3);
    const metric = await metrics.consumerDlq.get();
    expect(metric.values[0]?.value).toBe(3);
  });

  test('does not expose non-required inflight or publish-success families', async () => {
    const metrics = new MetricsService();
    const names = (await metrics.registry.getMetricsAsJSON())
      .map((metric) => metric.name)
      .filter((name) => !name.startsWith('process_') && !name.startsWith('nodejs_'));
    expect(names).toEqual([
      'wallet_reconciliation_divergences_total',
      'consumer_inbox_received_total',
      'consumer_dlq_depth',
      'consumer_processing_seconds',
      'outbox_lag_seconds',
      'wallet_lock_conflicts_total',
      'outbox_publish_failures_total',
    ]);
  });
});
