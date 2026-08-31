import { Inject, Injectable } from '@nestjs/common';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MIKRO_ORM } from '../infrastructure/database/entities';
import type { AppOrm } from '../infrastructure/database/orm.module';
import type { AppEnv } from '../config/env';
import { queueUrl } from './sqs.client';
import type { LoggerLike } from './command-consumer';
import { ConsumerShutdown } from './consumer-shutdown';
import { OutboxRepository, type OutboxRow } from './outbox.repository';
import { MetricsService } from '../observability/metrics.service';
import { maybeInjectPrePublishFault } from './test-hooks';

export type SendFailureReason = 'network' | 'throttle' | 'permanent';

/** Carries the claimed row out of the rolled-back transaction for rescheduling. */
class SendFailedError extends Error {
  constructor(
    readonly row: OutboxRow,
    readonly reason: SendFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'SendFailedError';
  }
}

/**
 * OutboxPublisher — poll-and-publish cycle for the transactional outbox.
 *
 * Each cycle claims exactly one due PENDING row per transaction with
 * `FOR UPDATE SKIP LOCKED`, sends the envelope to `wager-events.fifo`
 * (MessageDeduplicationId = event_id, MessageGroupId = walletId →
 * wagerTransactionId), and marks the row PUBLISHED in the same transaction
 * only after the broker accepted the event. Concurrent publisher instances
 * divide rows naturally via SKIP LOCKED.
 *
 * `event_id` never changes, so a send that was accepted by SQS but whose
 * commit failed is re-sent with the same dedup id — the FIFO 5-minute dedup
 * window drops the duplicate (see scenario 3 in the integration spec).
 *
 * Shutdown: `signalShutdown()` is checked before every claim and every send;
 * an in-flight claim+send+commit runs to completion and is registered against
 * the shared ConsumerShutdown so the coordinator can drain it.
 */
@Injectable()
export class OutboxPublisher {
  private readonly eventsQueueUrl: string;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(MIKRO_ORM) private readonly orm: Promise<AppOrm>,
    @Inject('SQS_CLIENT') private readonly client: SQSClient,
    @Inject('APP_ENV') private readonly env: AppEnv,
    private readonly outbox: OutboxRepository,
    private readonly shutdown: ConsumerShutdown,
    private readonly metrics: MetricsService,
    private readonly logger: LoggerLike,
  ) {
    this.eventsQueueUrl = queueUrl(this.env, this.env.QUEUE_EVENTS);
  }

  // Shutdown surface — delegates to the shared coordinator, which also tracks
  // the command consumer. `run()` in main.ts calls these alongside the
  // consumer's.
  signalShutdown(): void {
    this.shutdown.signalShutdown();
  }

  isShuttingDown(): boolean {
    return this.shutdown.isShuttingDown();
  }

  waitForDrained(timeoutMs: number): Promise<boolean> {
    return this.shutdown.waitForDrained(timeoutMs);
  }

  /** Resolves once the polling loop has observed shutdown and returned. */
  waitForStopped(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** Blocking poll-and-publish loop; returns when shutdown is signalled. */
  async start(): Promise<void> {
    this.running = this.runLoop();
    await this.running;
  }

  private async runLoop(): Promise<void> {
    this.logger.log({}, 'outbox publisher started');
    while (!this.shutdown.isShuttingDown()) {
      const stats = await this.cycle();
      if (stats.processed === 0) {
        // No work left: idle-wait the poll interval instead of spinning.
        await sleep(this.env.OUTBOX_POLL_INTERVAL_MS);
      }
      // Work existed → cycle immediately (spec 8.2).
    }
    this.logger.log({}, 'outbox publisher stopped');
  }

  /**
   * One drain pass: publish up to OUTBOX_BATCH_SIZE due rows, one row per
   * transaction, looping immediately while work is available. Ends early on
   * shutdown. Always refreshes the `outbox_lag_seconds` gauge.
   */
  async cycle(): Promise<{ processed: number; published: number; failed: number }> {
    const stats = { processed: 0, published: 0, failed: 0 };
    for (let i = 0; i < this.env.OUTBOX_BATCH_SIZE; i++) {
      if (this.shutdown.isShuttingDown()) break;
      const outcome = await this.claimAndPublish();
      if (outcome === null) break;
      stats.processed++;
      if (outcome === 'published') stats.published++;
      else stats.failed++;
    }
    const lag = await this.outbox.lagSeconds();
    this.metrics.setOutboxLag(lag);
    this.logger.debug({ ...stats, lagSeconds: lag }, 'outbox publish cycle');
    return stats;
  }

  /**
   * Claim one row and publish it. Returns 'published' | 'failed' | null
   * (null = nothing due, or shutdown aborted the claim).
   */
  private async claimAndPublish(): Promise<'published' | 'failed' | null> {
    if (this.shutdown.isShuttingDown()) return null;
    const em = (await this.orm).em.fork();
    this.shutdown.beginWork();
    try {
      let result: 'published' | null;
      try {
        result = await em.transactional(async (txEm) => {
          const row = await this.outbox.claimDue(txEm);
          if (!row) return null;
          // Shutdown guard before the outbound call: leaving the row
          // untouched makes it visible to the next instance.
          if (this.shutdown.isShuttingDown()) return null;
          try {
            // Returns false when shutdown flipped after the guard above —
            // in that case the row must NOT be marked PUBLISHED.
            if (!(await this.sendMessage(row))) return null;
          } catch (err) {
            // Roll back (releases the row lock), then reschedule outside the
            // transaction. The send's effect on the broker is not undone.
            throw new SendFailedError(row, classifySendError(err), messageOf(err));
          }
          await this.outbox.markPublished(txEm, row.id);
          this.logger.log({
            eventId: row.event_id,
            eventType: row.event_type,
            ...eventContext(row.payload),
          }, 'outbox event published');
          return 'published';
        });
      } catch (err) {
        if (err instanceof SendFailedError) {
          await this.rescheduleAfterFailure(err);
          return 'failed';
        }
        // Claim/commit-side transient (e.g. DB connection dropped) — the row
        // stays PENDING; the next cycle or another instance picks it up.
        this.logger.warn({ err: messageOf(err) }, 'outbox claim or commit failed');
        return null;
      }
      return result;
    } finally {
      this.shutdown.endWork();
      em.clear();
    }
  }

  /** Returns false when shutdown aborted the send — the row stays PENDING. */
  private async sendMessage(row: OutboxRow): Promise<boolean> {
    if (this.shutdown.isShuttingDown()) return false;
    // TEST-ONLY fault injection (slice 9.5): after the SKIP LOCKED claim,
    // before the SendMessage. Throws when FAULT_INJECT_PRE_PUBLISH_EVENT_ID
    // matches; the throw rolls the claim back and another cycle publishes.
    maybeInjectPrePublishFault(row.event_id);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.eventsQueueUrl,
        MessageBody: row.payload,
        MessageDeduplicationId: row.event_id,
        MessageGroupId: aggregateIdFor(row.payload),
      }),
    );
    return true;
  }

  /**
   * Post-rollback rescheduling of a failed send. Transient failures
   * (network/throttle) retry with exponential backoff capped at 60s — one
   * step sooner than permanent ones. A permanent failure that reaches
   * OUTBOX_MAX_ATTEMPTS is left PENDING (auditable) with `next_attempt_at`
   * pushed a day out so the publisher stops claiming it.
   */
  private async rescheduleAfterFailure(failure: SendFailedError): Promise<void> {
    const em = (await this.orm).em.fork();
    try {
      const attemptsAfter = failure.row.attempts + 1;
      if (failure.reason === 'permanent' && attemptsAfter >= this.env.OUTBOX_MAX_ATTEMPTS) {
        await this.outbox.markFailed(em, failure.row.id, 86_400, failure.message);
        this.metrics.recordOutboxPublishFailure('permanent');
        this.logger.error(
          {
            eventId: failure.row.event_id,
            eventType: failure.row.event_type,
            attempts: attemptsAfter,
            ...eventContext(failure.row.payload),
          },
          'outbox event exhausted retries — left PENDING, not published',
        );
        return;
      }
      const delaySeconds = backoffSeconds(failure.reason, failure.row.attempts);
      await this.outbox.markFailed(em, failure.row.id, delaySeconds, failure.message);
      this.metrics.recordOutboxPublishFailure(failure.reason);
      this.logger.warn(
        {
          eventId: failure.row.event_id,
          eventType: failure.row.event_type,
          reason: failure.reason,
          nextAttemptInSeconds: delaySeconds,
          ...eventContext(failure.row.payload),
        },
        'outbox publish failed — rescheduled',
      );
    } finally {
      em.clear();
    }
  }
}

/** Exponential backoff (base 1s, cap 60s); permanent retries one step behind transient. */
export function backoffSeconds(reason: SendFailureReason, attemptsBefore: number): number {
  const exponent = Math.min(reason === 'permanent' ? attemptsBefore + 1 : attemptsBefore, 10);
  return Math.min(60, 2 ** exponent);
}

/**
 * Classify a SendMessage failure. 5xx/network → retry sooner; throttling →
 * retry sooner; anything with a recognizable SQS validation shape → permanent.
 */
export function classifySendError(err: unknown): SendFailureReason {
  const e = (err ?? {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const status = e.$metadata?.httpStatusCode;
  const haystack = `${String(e.name ?? '')} ${String(e.code ?? '')} ${String(e.message ?? '')}`;
  const lower = haystack.toLowerCase();
  if (status === 429 || /throttl|slow.?down|too many request/i.test(lower)) return 'throttle';
  if (typeof status === 'number' && status >= 500) return 'network';
  if (/econnrefused|econnreset|timeout|timed out|socket|network|eai_again|fetch failed|connection refused/i.test(lower)) {
    return 'network';
  }
  // No status and no recognisable error shape → assume transient infra trouble.
  if (status === undefined && !e.name && !e.code) return 'network';
  return 'permanent';
}

/**
 * FIFO MessageGroupId: prefer the walletId so events of one wallet stay
 * ordered; fall back to the wager transaction, then the envelope aggregateId.
 */
export function aggregateIdFor(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { aggregateId?: unknown; data?: Record<string, unknown> };
    const data = parsed.data ?? {};
    if (typeof data.walletId === 'string') return data.walletId;
    if (typeof data.wagerTransactionId === 'string') return data.wagerTransactionId;
    if (typeof parsed.aggregateId === 'string') return parsed.aggregateId;
  } catch {
    // Fall through to the constant below.
  }
  return 'outbox-event';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extracts only safe identifiers from an event envelope; never logs payload data. */
function eventContext(payload: string): {
  correlationId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
} {
  try {
    const envelope = JSON.parse(payload) as {
      correlationId?: unknown;
      data?: Record<string, unknown>;
    };
    const data = envelope.data ?? {};
    const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
    const correlationId = text(envelope.correlationId);
    const walletId = text(data.walletId);
    const providerId = text(data.providerId);
    const transactionId = text(data.transactionId) ?? text(data.wagerTransactionId);
    return {
      ...(correlationId ? { correlationId } : {}),
      ...(transactionId ? { transactionId } : {}),
      ...(walletId ? { walletId } : {}),
      ...(providerId ? { providerId } : {}),
    };
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
