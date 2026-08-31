/**
 * Slice 8 unit tests — OutboxRepository claim/mark transitions + publisher
 * pure logic. Uses real PostgreSQL (real SQL, per the task); the SQS client
 * is stubbed — the wire behaviour against real LocalStack lives in
 * tests/integration/outbox-publisher.spec.ts.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import pino from 'pino';
import { loadEnv, type AppEnv } from '../config/env';
import { createOrm } from '../infrastructure/database/orm.module';
import type { AppOrm } from '../infrastructure/database/orm.module';
import { MetricsService } from '../observability/metrics.service';
import { ConsumerShutdown } from './consumer-shutdown';
import type { LoggerLike } from './command-consumer';
import { OutboxRepository } from './outbox.repository';
import {
  OutboxPublisher,
  aggregateIdFor,
  backoffSeconds,
  classifySendError,
} from './outbox-publisher';

const env: AppEnv = { ...loadEnv(), OUTBOX_POLL_INTERVAL_MS: 0 };

const orm: AppOrm = await createOrm(env);
await orm.connect();
const ormProvider = Promise.resolve(orm);
const admin = new Pool({ connectionString: env.DATABASE_URL });

const repo = new OutboxRepository(ormProvider);
const metrics = new MetricsService();
const shutdown = new ConsumerShutdown(env);
const pinoLogger = pino({ level: 'silent' });
const logger: LoggerLike = {
  log: (o, m) => pinoLogger.info(o, m),
  warn: (o, m) => pinoLogger.warn(o, m),
  error: (o, m) => pinoLogger.error(o, m),
  debug: (o, m) => pinoLogger.debug(o, m),
};

/** SQS stub — records commands, or fails per the supplied handler. */
function fakeSqs(
  handler: (cmd: unknown) => Promise<unknown>,
): SQSClient {
  return { send: handler } as unknown as SQSClient;
}

function outboxPayload(eventId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId,
    eventType: 'WagerTransactionProcessed',
    aggregateId: 'wallet-1',
    correlationId: null,
    occurredAt: new Date().toISOString(),
    version: 1,
    data: {
      wagerTransactionId: 'tx-1',
      walletId: 'wallet-1',
      type: 'BET',
      status: 'PROCESSED',
      amount: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    },
  });
}

async function insertRow(
  overrides: {
    eventId?: string;
    eventType?: string;
    payload?: string;
    nextAttemptAgo?: string;
    createdAtAgo?: string;
    status?: string;
  } = {},
): Promise<string> {
  const eventId = overrides.eventId ?? crypto.randomUUID();
  await admin.query(
    `INSERT INTO outbox (event_id, event_type, schema_version, payload, status, next_attempt_at, created_at)
     VALUES ($1, $2, 1, $3::jsonb, $4, now() - $5::interval, now() - $6::interval)`,
    [
      eventId,
      overrides.eventType ?? 'WagerTransactionProcessed',
      overrides.payload ?? outboxPayload(eventId),
      overrides.status ?? 'PENDING',
      overrides.nextAttemptAgo ?? '1 second',
      overrides.createdAtAgo ?? '0 seconds',
    ],
  );
  return eventId;
}

async function outboxRow(eventId: string): Promise<{
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  published_at: Date | null;
} | null> {
  const r = await admin.query(
    `SELECT status, attempts, next_attempt_at, last_error, published_at FROM outbox WHERE event_id = $1`,
    [eventId],
  );
  return r.rows[0] ?? null;
}

async function truncateOutbox(): Promise<void> {
  await admin.query('TRUNCATE outbox RESTART IDENTITY CASCADE');
}

beforeEach(truncateOutbox);

afterAll(async () => {
  await admin.end().catch(() => undefined);
  await orm.close(true);
});

describe('OutboxRepository claim/mark transitions', () => {
  test('claimDue returns a due PENDING row once; markPublished flips it to PUBLISHED', async () => {
    const eventId = await insertRow();

    const em = orm.em.fork();
    const first = await em.transactional((tx) => repo.claimDue(tx));
    expect(first).not.toBeNull();
    expect(first!.event_id).toBe(eventId);
    expect(first!.payload).toContain('"eventId"');

    await em.transactional((tx) => repo.markPublished(tx, first!.id));
    em.clear();

    const row = await outboxRow(eventId);
    expect(row!.status).toBe('PUBLISHED');
    expect(row!.attempts).toBe(1);
    expect(row!.published_at).not.toBeNull();

    // A PUBLISHED row is never claimed again.
    const em2 = orm.em.fork();
    const again = await em2.transactional((tx) => repo.claimDue(tx));
    expect(again).toBeNull();
    em2.clear();
  });

  test('markFailed keeps the row PENDING, bumps attempts, schedules next_attempt_at and records last_error', async () => {
    const eventId = await insertRow();

    const em = orm.em.fork();
    const claimed = await em.transactional((tx) => repo.claimDue(tx));
    expect(claimed).not.toBeNull();
    const before = Date.now();
    await em.transactional((tx) => repo.markFailed(tx, claimed!.id, 2, 'boom'));
    em.clear();

    const row = await outboxRow(eventId);
    expect(row!.status).toBe('PENDING');
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe('boom');
    expect(row!.next_attempt_at.getTime()).toBeGreaterThan(before + 1500);
    expect(row!.next_attempt_at.getTime()).toBeLessThan(before + 2500);

    // Not due yet → not claimable until next_attempt_at passes.
    const em2 = orm.em.fork();
    const again = await em2.transactional((tx) => repo.claimDue(tx));
    expect(again).toBeNull();
    em2.clear();
  });

  test('countDue only counts PENDING rows that are due now', async () => {
    await insertRow({ nextAttemptAgo: '1 second' }); // due
    await insertRow({ nextAttemptAgo: '1 second', status: 'PUBLISHED' }); // published → ignored
    await insertRow({ nextAttemptAgo: '-1 hour' }); // PENDING but not due yet

    expect(await repo.countDue()).toBe(1);
  });

  test('lagSeconds reports the age of the oldest PENDING row and resets when published', async () => {
    const eventId = await insertRow({ createdAtAgo: '5 seconds' });

    const lagBefore = await repo.lagSeconds();
    expect(lagBefore).toBeGreaterThanOrEqual(5);

    const em = orm.em.fork();
    const claimed = await em.transactional((tx) => repo.claimDue(tx));
    await em.transactional((tx) => repo.markPublished(tx, claimed!.id));
    em.clear();
    void eventId;

    expect(await repo.lagSeconds()).toBe(0);
  });

  test('SKIP LOCKED hands a claimed row to exactly one transaction at a time', async () => {
    await insertRow();

    const emA = orm.em.fork();
    const emB = orm.em.fork();
    let releaseA = (): void => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const claimA = emA.transactional(async (tx) => {
      const row = await repo.claimDue(tx);
      await gateA; // hold the row lock open while B tries
      return row;
    });
    // Let A's BEGIN + SELECT land before B attempts its claim.
    await new Promise((r) => setTimeout(r, 150));
    const rowB = await emB.transactional((tx) => repo.claimDue(tx));

    expect(rowB).toBeNull(); // SKIP LOCKED: B skipped A's locked row

    releaseA();
    const rowA = await claimA;
    expect(rowA).not.toBeNull();

    await emA.transactional(async (tx) => {
      await repo.markPublished(tx, rowA!.id);
    });
    emA.clear();
    emB.clear();
  });
});

describe('OutboxPublisher cycle', () => {
  test('publishes a due row with stable dedup id and wallet group id, then marks it PUBLISHED', async () => {
    const eventId = await insertRow();
    const sent: Array<Record<string, unknown>> = [];
    const client = fakeSqs(async (cmd) => {
      const c = cmd as { input?: Record<string, unknown> };
      sent.push(c.input ?? {});
      return { MessageId: `m-${sent.length}` };
    });

    const pub = new OutboxPublisher(ormProvider, client, env, repo, shutdown, metrics, logger);
    const stats = await pub.cycle();

    expect(stats.processed).toBe(1);
    expect(stats.published).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.MessageDeduplicationId).toBe(eventId);
    expect(sent[0]!.MessageGroupId).toBe('wallet-1');
    expect((await outboxRow(eventId))!.status).toBe('PUBLISHED');
  });

  test('a failed send leaves the row PENDING and reschedules with exponential backoff', async () => {
    const eventId = await insertRow();
    const client = fakeSqs(async () => {
      throw Object.assign(new Error('ServiceUnavailable'), {
        $metadata: { httpStatusCode: 503 },
      });
    });

    const pub = new OutboxPublisher(ormProvider, client, env, repo, shutdown, metrics, logger);
    const stats = await pub.cycle();

    expect(stats.processed).toBe(1);
    expect(stats.failed).toBe(1);
    const row = await outboxRow(eventId);
    expect(row!.status).toBe('PENDING');
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain('ServiceUnavailable');

    const failures = await metrics.outboxPublishFailures.get();
    expect(failures.values.some((v) => v.labels.reason === 'network' && v.value > 0)).toBe(true);
  });

  test('cycle respects the batch size and shutdown guard', async () => {
    for (let i = 0; i < 25; i++) await insertRow();
    const client = fakeSqs(async () => ({ MessageId: 'm' }));
    const coord = new ConsumerShutdown(env); // own coordinator so the shared one stays open

    const pub = new OutboxPublisher(ormProvider, client, env, repo, coord, metrics, logger);
    const stats = await pub.cycle();

    expect(stats.processed).toBe(env.OUTBOX_BATCH_SIZE); // 10 per cycle, not all 25
    expect(stats.published).toBe(env.OUTBOX_BATCH_SIZE);

    coord.signalShutdown();
    expect(pub.isShuttingDown()).toBe(true);
    const after = await pub.cycle();
    expect(after.processed).toBe(0); // guard stops new claims
  });
});

describe('classifySendError / backoffSeconds / aggregateIdFor', () => {
  test('classifies 5xx and network errors as transient, throttling separately, validation as permanent', () => {
    expect(classifySendError({ $metadata: { httpStatusCode: 503 } })).toBe('network');
    expect(classifySendError(Object.assign(new Error('connect ECONNREFUSED'), { $metadata: {} }))).toBe('network');
    expect(classifySendError({ $metadata: { httpStatusCode: 429 } })).toBe('throttle');
    expect(classifySendError(Object.assign(new Error('RequestThrottledException'), { $metadata: { httpStatusCode: 400 } }))).toBe('throttle');
    expect(classifySendError(Object.assign(new Error('QueueDoesNotExist'), { $metadata: { httpStatusCode: 400 } }))).toBe('permanent');
    expect(classifySendError(Object.assign(new Error('MessageTooLong'), { $metadata: { httpStatusCode: 400 } }))).toBe('permanent');
  });

  test('backoff is capped at 60s and permanent retries one step behind transient', () => {
    expect(backoffSeconds('network', 0)).toBe(1);
    expect(backoffSeconds('network', 5)).toBe(32);
    expect(backoffSeconds('network', 6)).toBe(60);
    expect(backoffSeconds('permanent', 0)).toBe(2);
    expect(backoffSeconds('permanent', 4)).toBe(32);
    expect(backoffSeconds('throttle', 0)).toBe(1);
  });

  test('aggregateIdFor prefers walletId, falls back to wagerTransactionId, then envelope aggregateId', () => {
    const withWallet = outboxPayload(crypto.randomUUID(), { walletId: 'w-1', wagerTransactionId: 't-1' });
    expect(aggregateIdFor(withWallet)).toBe('w-1');
    const withTx = outboxPayload(crypto.randomUUID(), { walletId: undefined, wagerTransactionId: 't-9' });
    expect(aggregateIdFor(withTx)).toBe('t-9');
    const withAggregate = '{"aggregateId":"agg-7","data":{}}';
    expect(aggregateIdFor(withAggregate)).toBe('agg-7');
    expect(aggregateIdFor('not json')).toBe('outbox-event');
  });
});