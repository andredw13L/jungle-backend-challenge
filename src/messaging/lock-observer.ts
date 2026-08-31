import { Injectable } from '@nestjs/common';
import { MetricsService } from '../observability/metrics.service';

/**
 * LockObserver — records wallet lock contention for the mandatory
 * `wallet_lock_conflicts_total` counter (operational-readiness spec).
 *
 * Slice 8 exposes the counter but does NOT own the financial deep module
 * (`process-wager.ts`, slice 9 territory). The intended wiring: call
 * `recordConflict(walletId)` from `resolveReversal` and
 * `processBalanceChange` AFTER a `lockWallet`/`lockWalletById` attempt raises
 * Postgres `55P03 lock_not_available` (a NOWAIT/deadlock-detect conflict).
 * Until that deep-module call site lands in slice 9, the counter stays at
 * zero hits — it must still be present on GET /metrics.
 */
@Injectable()
export class LockObserver {
  constructor(private readonly metrics: MetricsService) {}

  recordConflict(walletId: string): void {
    void walletId; // slice 9 may turn this into a label or a debug log
    this.metrics.recordWalletLockConflict();
  }
}