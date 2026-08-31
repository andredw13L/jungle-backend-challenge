/**
 * Slice 8 integration tests — transactional Outbox publisher against real
 * LocalStack + real PostgreSQL. Covers the reliable-messaging spec's
 * "Publicar eventos da Outbox transacional" scenarios:
 *   1. two concurrent publishers divide 50 due rows via SKIP LOCKED; every
 *      row PUBLISHED exactly once (attempts==1 ⇒ no duplicate SendMessage)
 *   2. broker unavailable → transient backoff → restored endpoint resumes
 *   3. SQS accepted the event but the DB commit rolled back → FIFO dedup
 *      keeps exactly ONE visible event
 *   4. same event_id re-published manually → dedup idempotency, count stays 1
 *   5. outbox_lag_seconds reflects the age of the oldest PENDING event
 *   6. permanent failure exhausts OUTBOX_MAX_ATTEMPTS → row stays PENDING,
 *      permanent failure counter increments
 *
 * State is reset per test: TRUNCATE outbox + PurgeQueue on wager-events.fifo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import pino from 'pino';
import { loadEnv, type AppEnv } from '../../src/config/env';
import { createOrm } from '../../src/infrastructure/database/orm.module';
import type { AppOrm } from '../../src/infrastructure/database/orm.module';
import { MetricsService } from '../../src/observability/metrics.service';
import { ConsumerShutdown } from '../../src/messaging/consumer-shutdown';
import type { LoggerLike } from '../../src/messaging/command-consumer';
import { OutboxRepository } from '../../src/messaging/outbox.repository';
import { OutboxPublisher, aggregateIdFor } from '../../src/messaging/outbox-publisher';
import { buildSqsClient, queueUrl } from '../../src/messaging/sqs.client';

// Fast cycles so tests never block on the 1s idle wait.
const env: AppEnv = { ...loadEnv(), OUTBOX_POLL_INTERVAL_MS: 0 };

const orm: AppOrm = await createOrm(env);
await orm.connect();
const ormProvider = Promise.resolve(orm);
const admin = new Pool({ connectionString: env.DATABASE_URL });

const metrics = new MetricsService();
const pinoLogger = pino({ level: 'silent' });
const logger: LoggerLike = {
  log: (o, m) => pinoLogger.info(o, m),
  warn: (o, m) => pinoLogger.warn(o, m),
  error: (o, m) => pinoLogger.error(o, m),
  debug: (o, m) => pinoLogger.debug(o, m),
};

const sqs: SQSClient = buildSqsClient(env);
const eventsQueue = queueUrl(env, env.QUEUE_EVENTS);

function makePublisher(
  envOverride: AppEnv = env,
  client: SQSClient = sqs,
  repo: OutboxRepository = new OutboxRepository(ormProvider),
): OutboxPublisher {
  return new OutboxPublisher(
    ormProvider,
    client,
    envOverride,
    repo,
    new ConsumerShutdown(envOverride),
    metrics,
    logger,
  );
}

function outboxPayload(eventId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId,
    eventType: 'WagerTransactionProcessed',
    aggregateId: 'wallet-int-1',
    correlationId: null,
    occurredAt: new Date().toISOString(),
    version: 1,
    data: {
      wagerTransactionId: 'tx-int-1',
      walletId: 'wallet-int-1',
      type: 'BET',
      status: 'PROCESSED',
      amount: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    },
  });
}

async function insertOutboxRow(
  overrides: {
    eventId?: string;
    eventType?: string;
    payload?: string;
    nextAttemptAgo?: string;
    createdAtAgo?: string;
  } = {},
): Promise<string> {
  const eventId = overrides.eventId ?? crypto.randomUUID();
  await admin.query(
    `INSERT INTO outbox (event_id, event_type, schema_version, payload, status, next_attempt_at, created_at)
     VALUES ($1, $2, 1, $3::jsonb, 'PENDING', now() - $4::interval, now() - $5::interval)`,
    [
      eventId,
      overrides.eventType ?? 'WagerTransactionProcessed',
      overrides.payload ?? outboxPayload(eventId),
      overrides.nextAttemptAgo ?? '1 second',
      overrides.createdAtAgo ?? '0 seconds',
    ],
  );
  return eventId;
}

async function outboxRow(eventId: string): Promise<{
  status: string;
  attempts: number;
  last_error: string | null;
  payload: string;
} | null> {
  const r = await admin.query(
    `SELECT status, attempts, last_error, payload FROM outbox WHERE event_id = $1`,
    [eventId],
  );
  return r.rows[0] ?? null;
}

async function truncateOutbox(): Promise<void> {
  await admin.query('TRUNCATE outbox RESTART IDENTITY CASCADE');
}

async function purgeEvents(): Promise<void> {
  try {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: eventsQueue }));
  } catch {
    // already empty
  }
  // LocalStack applies purges asynchronously.
  await new Promise((r) => setTimeout(r, 200));
}

/** Drain wager-events.fifo, deleting as we go; returns the received envelopes. */
async function drainEvents(): Promise<{ body: string; dedupId: string | null }[]> {
  const seen: { body: string; dedupId: string | null }[] = [];
  for (let i = 0; i < 100; i++) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsQueue,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 1,
      }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) break;
    for (const m of messages) {
      seen.push({
        body: m.Body ?? '',
        dedupId: m.Attributes?.MessageDeduplicationId ?? null,
      });
      if (m.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsQueue, ReceiptHandle: m.ReceiptHandle }));
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return seen;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  await truncateOutbox();
  await purgeEvents();
});

afterEach(async () => {
  await truncateOutbox();
  await purgeEvents();
});

afterAll(async () => {
  await admin.end().catch(() => undefined);
  await orm.close(true);
});

describe('slice 8 — transactional Outbox publisher', () => {
  test('scenario 1: two concurrent publishers claim 50 rows via SKIP LOCKED — each published exactly once, no duplicate sends', async () => {
    const inserted: string[] = [];
    for (let i = 0; i < 50; i++) inserted.push(await insertOutboxRow());

    // Two publisher instances, each with its own OutboxRepository/EM chain,
    // sharing only the DB and the broker.
    const pubA = makePublisher(env, sqs, new OutboxRepository(ormProvider));
    const pubB = makePublisher(env, sqs, new OutboxRepository(ormProvider));
    const runA = pubA.start();
    const runB = pubB.start();

    await waitFor(
      async () => {
        const r = await admin.query(
          `SELECT count(*)::int AS c FROM outbox WHERE status = 'PUBLISHED'`,
        );
        return r.rows[0].c === 50;
      },
      30000,
      'all 50 rows PUBLISHED',
    );

    pubA.signalShutdown();
    pubB.signalShutdown();
    await runA;
    await runB;

    const rows = await admin.query(`SELECT event_id, status, attempts FROM outbox`);
    expect(rows.rows).toHaveLength(50);
    for (const row of rows.rows) {
      expect(row.status).toBe('PUBLISHED');
      // attempts==1 is the proof of no duplicate SendMessage: a row claimed
      // twice would carry attempts==2 (SQS FIFO dedup hides the duplicate).
      expect(row.attempts).toBe(1);
    }

    const drained = await drainEvents();
    expect(drained).toHaveLength(50);
    const eventIds = new Set(drained.map((d) => (JSON.parse(d.body) as { eventId: string }).eventId));
    expect(eventIds.size).toBe(50);
  }, 60000);

  test('scenario 2: broker unavailable → transient backoff; restored endpoint resumes publishing', async () => {
    const badEnv: AppEnv = { ...env, AWS_ENDPOINT_URL: 'http://127.0.0.1:9' };
    const badSqs = buildSqsClient(badEnv);
    const eventId = await insertOutboxRow();

    const badPub = makePublisher(badEnv, badSqs, new OutboxRepository(ormProvider));
    const runBad = badPub.start();
    await waitFor(async () => ((await outboxRow(eventId))?.attempts ?? 0) >= 1, 15000, 'first failed attempt');
    badPub.signalShutdown();
    await runBad;

    const afterBad = await outboxRow(eventId);
    expect(afterBad!.status).toBe('PENDING');
    expect(afterBad!.attempts).toBeGreaterThanOrEqual(1);
    expect(afterBad!.last_error).toMatch(/ECONNREFUSED/i);

    // Endpoint restored → the next cycle re-claims and publishes.
    const goodPub = makePublisher(env, sqs, new OutboxRepository(ormProvider));
    const runGood = goodPub.start();
    await waitFor(async () => (await outboxRow(eventId))?.status === 'PUBLISHED', 20000, 'row published after restore');
    goodPub.signalShutdown();
    await runGood;

    const final = await outboxRow(eventId);
    expect(final!.status).toBe('PUBLISHED');
    expect(final!.attempts).toBeGreaterThanOrEqual(2);

    const failures = await metrics.outboxPublishFailures.get();
    expect(failures.values.some((v) => v.labels.reason === 'network' && v.value > 0)).toBe(true);
  }, 60000);

  test('scenario 3: post-publish pre-commit failure — SQS accepted the event, DB rolled back; FIFO dedup keeps one visible event', async () => {
    const eventId = await insertOutboxRow();

    // Force the UPDATE-to-PUBLISHED inside the claim transaction to throw,
    // simulating a crash between SendMessage and commit.
    const repo = new OutboxRepository(ormProvider);
    const originalMarkPublished = repo.markPublished.bind(repo);
    let failNext = true;
    repo.markPublished = async (em, id) => {
      if (failNext) {
        failNext = false;
        throw new Error('simulated rollback after SQS accepted the event');
      }
      return originalMarkPublished(em, id);
    };
    const pub = makePublisher(env, sqs, repo);

    await pub.cycle();
    let row = await outboxRow(eventId);
    expect(row!.status).toBe('PENDING'); // the transaction rolled back
    expect(row!.attempts).toBe(0);
    expect(row!.last_error).toBeNull();
    expect(await drainEvents()).toHaveLength(1); // the send DID land on SQS

    // Next cycle: re-claim, re-send with the SAME event_id (dropped by the
    // FIFO 5-minute dedup window), then commit.
    await pub.cycle();
    row = await outboxRow(eventId);
    expect(row!.status).toBe('PUBLISHED');
    expect(row!.attempts).toBe(1);
    expect(await drainEvents()).toHaveLength(0); // duplicate send was deduplicated
  }, 30000);

  test('scenario 4: same event_id re-published manually — dedup idempotency, exactly one visible message', async () => {
    const eventId = await insertOutboxRow();
    const pub = makePublisher(env, sqs, new OutboxRepository(ormProvider));
    await pub.cycle();
    expect((await outboxRow(eventId))!.status).toBe('PUBLISHED');

    // A second publisher attempt re-sends the same event_id (crash-recovery
    // of an already-published row).
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: eventsQueue,
        MessageBody: outboxPayload(eventId),
        MessageDeduplicationId: eventId,
        MessageGroupId: aggregateIdFor(outboxPayload(eventId)),
      }),
    );

    const drained = await drainEvents();
    expect(drained).toHaveLength(1); // the duplicate was deduplicated
    expect((JSON.parse(drained[0]!.body) as { eventId: string }).eventId).toBe(eventId);
  }, 30000);

  test('scenario 5: outbox_lag_seconds reflects the age of the oldest PENDING event', async () => {
    for (let i = 0; i < 10; i++) {
      await insertOutboxRow({ nextAttemptAgo: '5 seconds', createdAtAgo: '5 seconds' });
    }
    // A not-yet-due PENDING row keeps the gauge meaningful after the 10 due
    // rows are published by the tick below.
    await insertOutboxRow({ nextAttemptAgo: '-1 hour', createdAtAgo: '6 seconds' });

    const pub = makePublisher(env, sqs, new OutboxRepository(ormProvider));
    await pub.cycle();

    const gauge = await metrics.outboxLag.get();
    expect(gauge.values[0]!.value).toBeGreaterThanOrEqual(5);
  }, 30000);

  test('scenario 6: permanent failure exhausts OUTBOX_MAX_ATTEMPTS — row stays PENDING, permanent counter increments', async () => {
    const env6: AppEnv = { ...env, OUTBOX_MAX_ATTEMPTS: 3, QUEUE_EVENTS: 'outbox-does-not-exist.fifo' };
    const sqs6 = buildSqsClient(env6);
    const eventId = await insertOutboxRow({ eventType: 'OversizedPayloadEvent' });

    const pub = makePublisher(env6, sqs6, new OutboxRepository(ormProvider));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await pub.cycle();
      if (((await outboxRow(eventId))?.attempts ?? 0) >= 3) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const row = await outboxRow(eventId);
    expect(row!.status).toBe('PENDING'); // never marked PUBLISHED
    expect(row!.attempts).toBe(3);
    expect(row!.last_error).not.toBeNull();

    // Exhausted rows are left alone (next_attempt_at pushed a day out).
    await pub.cycle();
    expect((await outboxRow(eventId))!.attempts).toBe(3);

    const failures = await metrics.outboxPublishFailures.get();
    const permanent = failures.values.find((v) => v.labels.reason === 'permanent');
    expect(permanent?.value ?? 0).toBeGreaterThan(0);
  }, 60000);
});