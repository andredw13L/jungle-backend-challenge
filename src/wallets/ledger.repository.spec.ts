import { describe, expect, test } from 'bun:test';
import type { PinoLogger } from 'nestjs-pino';
import type { MetricsService } from '../observability/metrics.service';
import type { AppOrm } from '../infrastructure/database/orm.module';
import { LedgerRepository } from './ledger.repository';

describe('LedgerRepository.reconcile', () => {
  test('returns README names and emits one safe metric/log per divergence', async () => {
    const warnings: Array<{ payload: Record<string, unknown>; message: string }> = [];
    let divergenceCount = 0;
    const orm = Promise.resolve({
      em: {
        fork: () => ({
          execute: async () => [
            {
              wallet_amount: '100.00',
              balance_currency: 'BRL',
              computed: '75.00',
              entries: '2',
              divergence: '25.00',
            },
          ],
        }),
      },
    } as unknown as AppOrm);
    const metrics = {
      recordReconciliationDivergence: () => {
        divergenceCount += 1;
      },
    } as unknown as MetricsService;
    const logger = {
      warn: (payload: Record<string, unknown>, message: string) => warnings.push({ payload, message }),
    } as unknown as PinoLogger;

    const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
    const result = await new LedgerRepository(orm, metrics, logger).reconcile(walletId);

    expect(result).toEqual({
      walletId,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '25.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
    });
    expect(divergenceCount).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload).toEqual({ walletId, checkedEntries: 2 });
    expect(JSON.stringify(warnings[0])).not.toMatch(/amount|balance|currency/i);
  });
});
