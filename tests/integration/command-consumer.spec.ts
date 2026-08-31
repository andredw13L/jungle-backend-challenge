/**
 * Slice 7 integration tests — SQS command consumer against real LocalStack +
 * real PostgreSQL. Covers the reliable-messaging spec scenarios:
 *   1. valid command → PROCESSED + ack
 *   2. redelivery of the same messageId → no duplicate financial effect
 *   3. new messageId + same idempotencyKey → replay via uq_wager_idempotency_key
 *   4. same messageId + conflicting body → permanent, DLQ
 *   5. malformed JSON → permanent, DLQ
 *   6. wallet grouping: intra-group order preserved, groups concurrent
 *   7. graceful shutdown: stop polling, drain in-flight, redeliver the rest
 *   8. transient infrastructure failure → no ack, redelivered, eventual success
 *
 * State is reset per test: SQL truncate of the financial tables + inbox, and
 * SQS PurgeQueue on both FIFO queues.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import pino from 'pino';
import { loadEnv, type AppEnv } from '../../src/config/env';
import { createOrm } from '../../src/infrastructure/database/orm.module';
import { WalletRepository } from '../../src/infrastructure/database/wallet.repository';
import { ProcessWager } from '../../src/wagering/process-wager';
import { WagerRepository } from '../../src/wagering/wager.repository';
import { MetricsService } from '../../src/observability/metrics.service';
import { InboxRepository, CONSUMER_NAME } from '../../src/messaging/inbox.repository';
import { CommandMessageHandler } from '../../src/messaging/command-message-handler';
import { CommandConsumer, type LoggerLike, type SqsMessage } from '../../src/messaging/command-consumer';
import { ConsumerShutdown } from '../../src/messaging/consumer-shutdown';
import { buildSqsClient, queueUrl } from '../../src/messaging/sqs.client';
import { WagerInfrastructureError } from '../../src/domain/errors';

// Fast polling so tests never block on the 20s long-poll; visibility short so
// redeliveries happen quickly; DLQ max receives left at the default of 5.
const env: AppEnv = { ...loadEnv(), SQS_WAIT_SECONDS: 0, SQS_VISIBILITY_SECONDS: 1 };

const orm = await createOrm(env);
await orm.connect();
const ormProvider = Promise.resolve(orm);
// Pool: the polling loops interleave reads with consumer processing.
const admin = new Pool({ connectionString: env.DATABASE_URL });

const wallets = new WalletRepository(ormProvider);
const wagers = new WagerRepository(ormProvider);
const processWager = new ProcessWager(ormProvider, wagers);
const inboxRepo = new InboxRepository(ormProvider);
const metrics = new MetricsService();
const shutdown = new ConsumerShutdown(env);
const pinoLogger = pino({ level: 'silent' });
const logger: LoggerLike = {
  log: (o, m) => pinoLogger.info(o, m),
  warn: (o, m) => pinoLogger.warn(o, m),
  error: (o, m) => pinoLogger.error(o, m),
  debug: (o, m) => pinoLogger.debug(o, m),
};

const sqs: SQSClient = buildSqsClient(env);
const commandQueue = queueUrl(env, env.QUEUE_COMMAND);
const dlqUrl = queueUrl(env, env.QUEUE_COMMAND_DLQ);

function makeHandler(pw: ProcessWager = processWager): CommandMessageHandler {
  return new CommandMessageHandler(ormProvider, inboxRepo, pw, metrics, env, logger);
}

function makeConsumer(
  handler: CommandMessageHandler = makeHandler(),
  shutdownCoordinator: ConsumerShutdown = shutdown,
): CommandConsumer {
  return new CommandConsumer(sqs, env, handler, shutdownCoordinator, metrics, logger);
}

const ALICE = '00000000-0000-7000-8000-0000000000a1';
const BOB = '00000000-0000-7000-8000-0000000000b2';

async function truncateAll(): Promise<void> {
  await admin.query(
    'TRUNCATE outbox, wallet_ledger_entries, wager_transactions, wallets, inbox RESTART IDENTITY CASCADE',
  );
}

async function purgeQueues(): Promise<void> {
  for (const url of [commandQueue, dlqUrl]) {
    try {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
    } catch {
      // queue may already be empty
    }
  }
  // LocalStack applies purges asynchronously; give it a beat.
  await new Promise((r) => setTimeout(r, 200));
}

async function createWalletWithBalance(playerId: string, amount: string): Promise<string> {
  const created = await wallets.createAtomic({
    id: crypto.randomUUID(),
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  return created.wallet.id;
}

function wagerBody(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    kind: 'BET',
    idempotencyKey: `it-${crypto.randomUUID()}`,
    providerId: 'prov-sqs',
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    playerId: ALICE,
    walletId: '00000000-0000-7000-8000-000000000000',
    roundId: 'round-sqs',
    gameId: 'game-sqs',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  });
}

async function sendCommand(body: string, groupId: string): Promise<string> {
  const res = await sqs.send(
    new SendMessageCommand({ QueueUrl: commandQueue, MessageBody: body, MessageGroupId: groupId }),
  );
  return res.MessageId!;
}

async function commandDepth(): Promise<number> {
  const r = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: commandQueue,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  return Number(r.Attributes?.ApproximateNumberOfMessages ?? 0);
}

async function dlqDepth(): Promise<number> {
  const r = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  return Number(r.Attributes?.ApproximateNumberOfMessages ?? 0);
}

async function receiveOne(): Promise<SqsMessage | null> {
  const res = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: commandQueue, MaxNumberOfMessages: 1, WaitTimeSeconds: 0 }),
  );
  const m = res.Messages?.[0];
  return m ? { MessageId: m.MessageId, Body: m.Body, ReceiptHandle: m.ReceiptHandle } : null;
}

async function inboxRow(messageId: string): Promise<{ received_count: number; processed_at: Date | null; body_hash: string } | null> {
  const r = await admin.query(
    `SELECT received_count, processed_at, body_hash FROM inbox WHERE consumer_name = $1 AND message_id = $2`,
    [CONSUMER_NAME, messageId],
  );
  return r.rows[0] ?? null;
}

async function ledgerFor(walletId: string): Promise<{ direction: string; value_amount: string; balance_before_amount: string; created_at: Date }[]> {
  const r = await admin.query(
    `SELECT le.direction, le.value_amount, le.balance_before_amount, le.created_at
     FROM wallet_ledger_entries le
     JOIN wager_transactions wt ON le.transaction_id = wt.id
     WHERE le.wallet_id = $1 AND wt.type <> 'OPENING'
     ORDER BY le.created_at, le.id`,
    [walletId],
  );
  return r.rows;
}

async function commandInFlight(): Promise<number> {
  const r = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: commandQueue,
      AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

/** Poll the consumer until the DLQ holds at least one message (or timeout). */
async function pollUntilDlq(timeoutMs = 30000): Promise<void> {
  const consumer = makeConsumer();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await dlqDepth()) > 0) return;
    await consumer.pollOnce();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`DLQ not reached within ${timeoutMs}ms (depth=${await dlqDepth()})`);
}

beforeAll(async () => {
  await truncateAll();
  await purgeQueues();
});

afterEach(async () => {
  await truncateAll();
  await purgeQueues();
});

afterAll(async () => {
  await admin.end().catch(() => undefined);
  await orm.close(true);
});

describe('slice 7 — SQS command consumer', () => {
  test('scenario 1: valid BET via SQS → PROCESSED, ack, inbox row with processed_at', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const body = wagerBody({ walletId: wid, playerId: ALICE });
    const messageId = await sendCommand(body, wid);

    const consumer = makeConsumer();
    await consumer.pollOnce();

    // ack: nothing left in the queue
    expect(await commandDepth()).toBe(0);

    const row = await inboxRow(messageId);
    expect(row).not.toBeNull();
    expect(row!.processed_at).not.toBeNull();

    const balance = await admin.query(`SELECT balance_amount FROM wallets WHERE id = $1`, [wid]);
    expect(balance.rows[0].balance_amount).toBe('90.00'); // BET debits

    const tx = await admin.query(
      `SELECT status, type FROM wager_transactions WHERE idempotency_key = $1`,
      [JSON.parse(body).idempotencyKey],
    );
    expect(tx.rows[0].status).toBe('PROCESSED');
    expect(tx.rows[0].type).toBe('BET');
  }, 15000);

  test('scenario 2: same messageId redelivered → inbox dedup, one financial effect, ack', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const body = wagerBody({ walletId: wid, playerId: ALICE });
    await sendCommand(body, wid);

    // Receive once and process WITHOUT acking (simulates crash between
    // commit and ack), then make the message visible again (redelivery).
    const first = await receiveOne();
    expect(first).not.toBeNull();
    const messageId = first!.MessageId!;

    const handler = makeHandler();
    const action = await handler.process(first!);
    expect(action).toBe('ack'); // business outcome, but no delete is issued here
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: commandQueue,
        ReceiptHandle: first!.ReceiptHandle!,
        VisibilityTimeout: 0,
      }),
    );

    // Second delivery of the SAME messageId → duplicate, acked, no new effect.
    const consumer = makeConsumer(handler);
    await consumer.pollOnce();

    expect(await commandDepth()).toBe(0); // acked this time
    const row = await inboxRow(messageId);
    expect(row!.received_count).toBeGreaterThanOrEqual(2);
    expect(row!.processed_at).not.toBeNull();

    const ledger = await ledgerFor(wid);
    const bets = ledger.filter((l) => l.direction === 'DEBIT' && l.value_amount === '10.00');
    expect(bets).toHaveLength(1); // exactly one financial effect
    const balance = await admin.query(`SELECT balance_amount FROM wallets WHERE id = $1`, [wid]);
    expect(balance.rows[0].balance_amount).toBe('90.00');
  }, 15000);

  test('scenario 3: new messageId + same idempotencyKey → replay, no duplicate effect, both acked', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const idempotencyKey = `shared-${crypto.randomUUID()}`;
    // Identical business payload on both sends — only transport metadata
    // (correlationId) differs, so the business body hash is unchanged.
    const externalTransactionId = `ext-${crypto.randomUUID()}`;
    const body1 = wagerBody({ walletId: wid, playerId: ALICE, idempotencyKey, externalTransactionId });
    await sendCommand(body1, wid);

    const consumer = makeConsumer();
    await consumer.pollOnce();
    expect(await commandDepth()).toBe(0);

    // Same business payload, different transport (correlationId) → SQS sees
    // new content and issues a NEW messageId; business body hash is unchanged.
    const body2 = wagerBody({ walletId: wid, playerId: ALICE, idempotencyKey, externalTransactionId, correlationId: 'transport-2' });
    const messageId2 = await sendCommand(body2, wid);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !(await inboxRow(messageId2))?.processed_at) {
      await consumer.pollOnce();
    }
    const row2 = await inboxRow(messageId2);
    expect(row2).not.toBeNull();
    expect(row2!.processed_at).not.toBeNull();
    expect(await commandDepth()).toBe(0); // both messages acked

    const ledger = await ledgerFor(wid);
    expect(ledger.filter((l) => l.direction === 'DEBIT' && l.value_amount === '10.00')).toHaveLength(1);
    const balance = await admin.query(`SELECT balance_amount FROM wallets WHERE id = $1`, [wid]);
    expect(balance.rows[0].balance_amount).toBe('90.00');
  }, 15000);

  test('scenario 4: same messageId + different body → IDEMPOTENCY_CONFLICT, DLQ', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const body = wagerBody({ walletId: wid, playerId: ALICE });
    const messageId = await sendCommand(body, wid);

    // A prior delivery of this messageId carried a different body.
    await admin.query(
      `INSERT INTO inbox (consumer_name, message_id, body_hash, received_count, first_received_at, last_received_at, processed_at, correlation_id)
       VALUES ($1, $2, 'deadbeef', 1, now(), now(), NULL, NULL)`,
      [CONSUMER_NAME, messageId],
    );

    await pollUntilDlq();

    expect(await dlqDepth()).toBeGreaterThan(0);
    const dlqMetric = await metrics.consumerDlq.get();
    expect(dlqMetric.values[0]!.value).toBeGreaterThan(0);
    const row = await inboxRow(messageId);
    expect(row!.received_count).toBeGreaterThan(5);
    // never processed, never a financial effect
    expect(row!.processed_at).toBeNull();
    const nonOpening = await admin.query(
      `SELECT count(*)::int AS c FROM wager_transactions WHERE type <> 'OPENING'`,
    );
    expect(nonOpening.rows[0].c).toBe(0);
  }, 40000);

  test('scenario 5: malformed JSON → permanent, lands in DLQ, no financial effect', async () => {
    await sendCommand('{not-valid-json{{{', 'malformed-group');
    await pollUntilDlq();

    expect(await dlqDepth()).toBeGreaterThan(0);
    const dlqMetric = await metrics.consumerDlq.get();
    expect(dlqMetric.values[0]!.value).toBeGreaterThan(0);
    const nonOpening = await admin.query(
      `SELECT count(*)::int AS c FROM wager_transactions WHERE type <> 'OPENING'`,
    );
    expect(nonOpening.rows[0].c).toBe(0);
  }, 40000);

  test('scenario 6: wallet grouping — intra-group order kept, walletB commits before walletA WIN', async () => {
    const walletA = await createWalletWithBalance(ALICE, '100.00');
    const walletB = await createWalletWithBalance(BOB, '100.00');

    const idA = await sendCommand(wagerBody({ walletId: walletA, playerId: ALICE, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } }), walletA);
    const idAw = await sendCommand(wagerBody({ walletId: walletA, playerId: ALICE, kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } }), walletA);
    const idB = await sendCommand(wagerBody({ walletId: walletB, playerId: BOB, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } }), walletB);

    const consumer = makeConsumer();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const rows = await Promise.all([idA, idAw, idB].map((id) => inboxRow(id)));
      if (rows.every((r) => r?.processed_at)) break;
      await consumer.pollOnce();
    }
    expect(await commandDepth()).toBe(0);

    // Intra-group FIFO: walletA ledger is DEBIT then CREDIT, and the WIN saw
    // the BET already applied (balance_before = 100 - 10).
    const ledgerA = await ledgerFor(walletA);
    expect(ledgerA.map((l) => l.direction)).toEqual(['DEBIT', 'CREDIT']);
    const win = ledgerA.find((l) => l.direction === 'CREDIT');
    expect(win!.balance_before_amount).toBe('90.00');

    const betB = (await ledgerFor(walletB)).find((l) => l.direction === 'DEBIT');
    expect(betB).toBeDefined();
    // Cross-group concurrency: walletB (independent) commits before walletA WIN.
    expect(betB!.created_at.getTime()).toBeLessThanOrEqual(win!.created_at.getTime());

    const balA = await admin.query(`SELECT balance_amount FROM wallets WHERE id = $1`, [walletA]);
    expect(balA.rows[0].balance_amount).toBe('95.00');
    const balB = await admin.query(`SELECT balance_amount FROM wallets WHERE id = $1`, [walletB]);
    expect(balB.rows[0].balance_amount).toBe('90.00');
  }, 25000);

  test('scenario 7: graceful shutdown — stops polling, drains in-flight, leaves the rest', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const body = wagerBody({ walletId: wid, playerId: ALICE });
    const messageId1 = await sendCommand(body, wid);

    const coordinator = new ConsumerShutdown(env);
    const consumer = makeConsumer(makeHandler(), coordinator);
    const running = consumer.start();

    // Wait for the in-flight message to be processed and acked.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const row = await inboxRow(messageId1);
      if (row?.processed_at) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await inboxRow(messageId1))!.processed_at).not.toBeNull();
    expect(await commandDepth()).toBe(0);

    // Signal shutdown: the loop must stop polling quickly.
    const t0 = Date.now();
    coordinator.signalShutdown();
    await running;
    expect(coordinator.isShuttingDown()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);

    // A message sent after shutdown is not consumed by this instance.
    await sendCommand(wagerBody({ walletId: wid, playerId: ALICE }), wid);
    await new Promise((r) => setTimeout(r, 800));
    expect(await commandDepth()).toBe(1); // untouched, available to the next instance
  }, 25000);

  test('scenario 8: transient infrastructure failure → no ack, redelivery succeeds', async () => {
    const wid = await createWalletWithBalance(ALICE, '100.00');
    const body = wagerBody({ walletId: wid, playerId: ALICE });
    const messageId = await sendCommand(body, wid);

    // First ProcessWager call fails transiently (closed-port/ECONNRESET
    // equivalent); subsequent calls succeed.
    let calls = 0;
    const flaky = Object.create(processWager) as ProcessWager;
    flaky.execute = async (input) => {
      calls++;
      if (calls === 1) throw new WagerInfrastructureError(new Error('ECONNRESET'));
      return processWager.execute(input);
    };

    const consumer = makeConsumer(makeHandler(flaky));
    await consumer.pollOnce();

    // Not acked: the message stays in flight (never deleted).
    expect(await commandInFlight()).toBeGreaterThan(0);
    const nonOpening = await admin.query(
      `SELECT count(*)::int AS c FROM wager_transactions WHERE type <> 'OPENING'`,
    );
    expect(nonOpening.rows[0].c).toBe(0);

    // Visibility timeout redelivers it; the next poll succeeds and acks.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !(await inboxRow(messageId))?.processed_at) {
      await new Promise((r) => setTimeout(r, 200));
      await consumer.pollOnce();
    }
    const row = await admin.query(
      `SELECT status FROM wager_transactions WHERE idempotency_key = $1`,
      [JSON.parse(body).idempotencyKey],
    );
    expect(row.rows[0].status).toBe('PROCESSED');
    expect(await commandDepth()).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 20000);
});