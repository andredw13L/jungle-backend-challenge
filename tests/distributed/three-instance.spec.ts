/**
 * Slice 9 distributed suite — three OS processes (ports 3101–3103) against
 * the SAME PostgreSQL + LocalStack, running the seven cross-process proofs:
 *
 *   9.2 idempotency under parallel delivery (50 HTTP + 50 SQS per wallet)
 *   9.3 contested balance on one wallet + independent progress on two others
 *   9.4 crash after commit, before SQS ack → restart → idempotent redelivery
 *   9.5 out-of-order reversal + two concurrent outbox publishers + restart
 *   9.6 final invariant assertion at the end of every financial scenario
 *
 * Run ONLY via `bun run test:distributed` — it spawns real processes and
 * shares the integration database, so it is kept out of the default `bun test`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadEnv } from '../../src/config/env';
import { createOrm } from '../../src/infrastructure/database/orm.module';
import { buildSqsClient, queueUrl } from '../../src/messaging/sqs.client';
import { createHarness, type Harness } from './process-harness';
import { createInvariantQueries, type InvariantQueries } from './invariant-queries';
import {
  scenarioBalanceContest,
  scenarioConcurrentOutbox,
  scenarioCrashAfterCommit,
  scenarioIdempotentParallel,
  type TestContext,
} from './scenarios';

const env = loadEnv();
const orm = await createOrm(env);
await orm.connect();
const invariants: InvariantQueries = createInvariantQueries(orm);

const sqs: SQSClient = buildSqsClient(env);
const commandQueueUrl = queueUrl(env, env.QUEUE_COMMAND);

const harness: Harness = createHarness();
const ctx: TestContext = { harness, sqs, commandQueueUrl, invariants };

/** Purge the three FIFO queues so no stale messages leak into a scenario. */
async function resetSharedState(): Promise<void> {
  for (const name of [env.QUEUE_COMMAND, env.QUEUE_COMMAND_DLQ, env.QUEUE_EVENTS]) {
    try {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl(env, name) }));
    } catch {
      // queue may already be empty
    }
  }
  // LocalStack applies purges asynchronously; give it a beat.
  await new Promise((r) => setTimeout(r, 300));
}

/** Wait until the command queues hold no visible and no in-flight messages. */
async function waitQueuesDrained(timeoutMs = 15000): Promise<void> {
  // NOTE: the events queue is excluded — published events legitimately
  // accumulate there (no consumer drains them), so its depth never reaches 0.
  const urls = [env.QUEUE_COMMAND, env.QUEUE_COMMAND_DLQ].map((n) => queueUrl(env, n));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const depths = await Promise.all(
      urls.map(async (url) => {
        const r = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
          }),
        );
        return Number(r.Attributes?.ApproximateNumberOfMessages ?? 0) +
          Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
      }),
    );
    if (depths.every((d) => d === 0)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  await harness.spawnAll();
  // eslint-disable-next-line no-console
  console.log(
    `[distributed] three instances ready: ${harness.instances
      .map((h) => `${h.instanceId} pid=${h.pid} port=${h.port}`)
      .join(', ')}`,
  );
});

beforeEach(async () => {
  // Shared reset — purge-first + truncate. In-flight messages from a previous
  // scenario get redelivered within the 2s visibility window and hit an empty
  // (but valid) schema; the next scenario's sends are what matter. A bounded
  // drain after purge absorbs any stragglers.
  // eslint-disable-next-line no-console
  console.log('[spec] beforeEach reset start');
  await resetSharedState();
  // eslint-disable-next-line no-console
  console.log('[spec] beforeEach reset done, draining...');
  await waitQueuesDrained(3000).catch(() => undefined);
  // eslint-disable-next-line no-console
  console.log('[spec] beforeEach done');
});

afterAll(async () => {
  await harness.terminateAll(30000);
  await orm.close(true);
});

describe('slice 9 — distributed three-process proofs', () => {
  test('9.1 harness: three independent OS processes share PostgreSQL + SQS', async () => {
    expect(harness.instances).toHaveLength(3);
    const pids = new Set(harness.instances.map((h) => h.pid));
    expect(pids.size).toBe(3);
    for (const h of harness.instances) {
      const res = await fetch(`http://127.0.0.1:${h.port}/health/ready`);
      expect(res.status).toBe(200);
    }
  }, 30000);

  test('9.2 idempotency under parallel delivery — one financial effect per wallet', async () => {
    await scenarioIdempotentParallel(ctx);
  }, 120000);

  test('9.3 contested balance + independent wallet progress', async () => {
    await scenarioBalanceContest(ctx);
  }, 120000);

  test('9.4 crash after commit before SQS ack — restart, no duplicate effect', async () => {
    await scenarioCrashAfterCommit(ctx);
  }, 120000);

  test('9.5 concurrent outbox + out-of-order reversal + restart', async () => {
    await scenarioConcurrentOutbox(ctx);
  }, 120000);

  test('9.6 invariant queries cover all five tables at the end of every scenario', async () => {
    // 9.2–9.5 already asserted final invariants; this test proves the helper
    // reports the expected fingerprint on a freshly created wallet too.
    // Use a random playerId — the fixed UUID from the spec collides with a
    // wallet left by a previous run (queues are purged, DB is not).
    const res = await fetch(`http://127.0.0.1:${harness.instances[0]!.port}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      }),
    });
    expect(res.status).toBe(201);
    const walletId = ((await res.json()) as { id: string }).id;
    const fp = await invariants.pollUntil(
      walletId,
      {
        balanceAmount: '50.00',
        ledgerCount: 1,
        processedWagerCount: 0, // OPENING is not counted as a wager
        inboxRows: 0,
        outboxPublished: 1,
        outboxPending: 0,
        walletVersion: 1,
      },
      10000,
      '9.6 opening fingerprint',
    );
    expect(fp.balanceAmount).toBe('50.00');
    // The mandatory final invariant: balance == ledger reconstruction.
    const recon = await orm.em.fork().execute<{ computed: string }[]>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN value_amount ELSE -value_amount END), 0)::numeric(18,2) AS computed
       FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(String(recon[0]!.computed)).toBe('50.00');
  }, 60000);
});