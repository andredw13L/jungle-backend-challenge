/**
 * Slice 9 distributed scenarios — the seven cross-process proofs (9.2–9.6).
 *
 * Each scenario boots its own wallet set against the shared PostgreSQL/SQS,
 * distributes work across the three OS processes on ports 3101–3103, and ends
 * by asserting the final invariants (9.6). Scenarios are standalone functions
 * so the orchestrator can run them individually.
 */
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Harness } from './process-harness';
import type { InvariantQueries } from './invariant-queries';

export interface TestContext {
  harness: Harness;
  sqs: SQSClient;
  commandQueueUrl: string;
  invariants: InvariantQueries;
}

interface WagerHttpBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** Create a wallet via HTTP on a round-robin instance; returns its id. */
async function createWallet(
  ctx: TestContext,
  playerId: string,
  amount: string,
): Promise<string> {
  const port = pickPort(ctx);
  const res = await fetch(`http://127.0.0.1:${port}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  if (res.status !== 201) {
    throw new Error(`wallet creation failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

/**
 * Same as submitHttpWithKey, but retries transient infrastructure failures
 * (deadlock detection aborts one racer with 40001 → 503). The retried request
 * MUST reuse the SAME idempotency key so it replays against the committed
 * winner instead of tripping EXTERNAL_TRANSACTION_CONFLICT on the shared
 * external id.
 */
async function submitHttpWithRetry(
  ctx: TestContext,
  body: WagerHttpBody,
  idempotencyKey: string,
  attempts = 5,
): Promise<{ status: number; body: unknown }> {
  let last: { status: number; body: unknown } | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await submitHttpWithKey(ctx, body, idempotencyKey);
    if (last.status < 500) {
      // eslint-disable-next-line no-console
      console.log(`[submit] ${body.kind} ${body.externalTransactionId} → ${last.status} ${JSON.stringify(last.body)}`);
      return last;
    }
    // Transient infra (deadlock/pool contention) — back off and retry.
    await sleep(300 * (i + 1));
  }
  return last!;
}

/** HTTP submit with a caller-provided idempotency key. */
async function submitHttpWithKey(
  ctx: TestContext,
  body: WagerHttpBody,
  idempotencyKey: string,
): Promise<{ status: number; body: unknown }> {
  const port = pickPort(ctx);
  const res = await fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Submit `count` wagers racing the same wallet; each gets a fresh external id. */
async function burstHttp(
  ctx: TestContext,
  count: number,
  body: WagerHttpBody,
  staggerMs = 0,
): Promise<{ status: number; body: unknown }[]> {
  // Run-unique base so leftover wagers from a previous run can never collide.
  const runToken = crypto.randomUUID();
  return Promise.all(
    Array.from({ length: count }, (_, k) =>
      (async () => {
        if (staggerMs > 0) await sleep(staggerMs * k);
        // Stable idempotency key per logical request: a retry after a
        // transient failure must replay the SAME idempotency key, otherwise it
        // trips EXTERNAL_TRANSACTION_CONFLICT on the shared external id.
        return submitHttpWithRetry(
          ctx,
          {
            ...body,
            externalTransactionId: `${body.externalTransactionId}-${runToken}-${k}`,
          },
          `race-${body.externalTransactionId}-${runToken}-${k}`,
        );
      })(),
    ),
  );
}

/** Enqueue a wager command on the SQS command queue. Returns the SQS message id. */
async function enqueueCommand(
  ctx: TestContext,
  body: WagerHttpBody & { correlationId?: string; idempotencyKey?: string },
): Promise<string> {
  const messageId = `msg-${crypto.randomUUID()}`;
  const { correlationId, ...business } = body;
  const res = await ctx.sqs.send(
    new SendMessageCommand({
      QueueUrl: ctx.commandQueueUrl,
      // The SQS handler requires the official envelope. Its business hash
      // excludes the embedded idempotency key, so HTTP and SQS replay alike.
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          ...business,
          idempotencyKey: body.idempotencyKey ?? `sqs-${crypto.randomUUID()}`,
        },
      }),
      MessageGroupId: body.walletId,
      ...(body.correlationId !== undefined
        ? { MessageDeduplicationId: `cmd-${body.correlationId}-${crypto.randomUUID()}` }
        : {}),
    }),
  );
  if (!res.MessageId) throw new Error('SQS SendMessage returned no MessageId');
  return messageId;
}

function pickPort(ctx: TestContext): number {
  const live = ctx.harness.instances.filter((h) => h.process.exitCode === null);
  return live[Math.floor(Math.random() * live.length)]!.port;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== null) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

function logScenarioStart(name: string, harness: Harness): void {
  // eslint-disable-next-line no-console
  console.log(
    `[scenario ${name}] instances: ${harness.instances
      .map((h) => `${h.instanceId} pid=${h.pid} port=${h.port}`)
      .join(', ')}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uuid(_seed: number): string {
  // Random player ids keep scenarios independent and re-runnable without a
  // DB reset (stale wallets from a previous run must not collide).
  return crypto.randomUUID();
}

/**
 * 9.2 — 50 identical HTTP submissions + 50 identical SQS commands per wallet,
 * across three wallets, all sharing one idempotency key each. Exactly one
 * financial effect per wallet.
 */
export async function scenarioIdempotentParallel(ctx: TestContext): Promise<void> {
  logScenarioStart('9.2-idempotent-parallel', ctx.harness);
  const runToken = crypto.randomUUID();
  const players = [uuid(1), uuid(2), uuid(3)];
  const wallets = await Promise.all(
    players.map((p) => createWallet(ctx, p, '1000.00')),
  );

  // Envelope messageIds sent per wallet — the inbox keys (correlation_id).
  const messageIdsByWallet = new Map<string, string[]>();

  await Promise.all(
    wallets.map(async (walletId, i) => {
      const playerId = players[i]!;
      const body: WagerHttpBody = {
        kind: 'BET',
        providerId: 'prov-92',
        externalTransactionId: `ext-92-${walletId}-${runToken}`,
        playerId,
        walletId,
        roundId: 'round-92',
        gameId: 'game-92',
        money: { amount: '10.00', currency: 'BRL' },
      };
      const idempotencyKey = `shared-92-${walletId}`;
      // 50 HTTP posts sharing the SAME idempotencyKey, round-robin across
      // ports; transient deadlock-aborts retry (they replay idempotently).
      const httpPosts = Array.from({ length: 50 }, (_, k) =>
        (async () => {
          const port = ctx.harness.instances[k % 3]!.port;
          const res = await fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
            body: JSON.stringify(body),
          });
          if (res.status >= 500) {
            // Deadlock detection aborted this racer; retry replays the winner.
            await sleep(200);
            const retry = await fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
              body: JSON.stringify(body),
            });
            return retry.status;
          }
          return res.status;
        })(),
      );
      // 50 SQS messages with the same business idempotency key and distinct
      // envelope messageIds.
      const sqsPosts = Array.from({ length: 50 }, () =>
        enqueueCommand(ctx, { ...body, idempotencyKey }),
      );
      const [httpResults, sqsMessageIds] = await Promise.all([
        Promise.all(httpPosts),
        Promise.all(sqsPosts),
      ]);
      messageIdsByWallet.set(walletId, sqsMessageIds);
      return [...httpResults, ...sqsMessageIds];
    }),
  );

  for (const walletId of wallets) {
    const messageIds = messageIdsByWallet.get(walletId)!;
    try {
      await ctx.invariants.pollUntil(
        walletId,
        {
          balanceAmount: '990.00',
          ledgerCount: 2, // opening + one BET
          processedWagerCount: 1,
          inboxRows: 50,
          outboxPublished: 3, // opening + WalletBalanceChanged + WagerTransactionProcessed
          outboxPending: 0,
          walletVersion: 2,
        },
        45000,
        '9.2 single-effect settlement',
        messageIds,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        `[scenario 9.2] INBOX DUMP for ${walletId}: ${JSON.stringify(
          await ctx.invariants.inboxSample(walletId),
        )}`,
      );
      for (const name of ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wager-events.fifo']) {
        const r = await ctx.sqs.send(
          new (await import('@aws-sdk/client-sqs')).GetQueueAttributesCommand({
            QueueUrl: `http://localhost:4566/000000000000/${name}`,
            AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
          }),
        );
        // eslint-disable-next-line no-console
        console.log(`[scenario 9.2] queue ${name}:`, JSON.stringify(r.Attributes));
      }
      throw err;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[scenario 9.2] inbox rows: ${JSON.stringify(await ctx.invariants.inboxSample(wallets[0]!))}`);
  for (const walletId of wallets) {
    const fp = await ctx.invariants.assertFinalInvariants(
      walletId,
      {
        balanceAmount: '990.00',
        ledgerCount: 2,
        processedWagerCount: 1,
        inboxRows: 50,
        outboxPublished: 3,
        outboxPending: 0,
        walletVersion: 2,
      },
      messageIdsByWallet.get(walletId)!,
    );
    // eslint-disable-next-line no-console
    console.log(`[scenario 9.2] final invariants for ${walletId}: ${JSON.stringify(fp)}`);
  }
}

/**
 * 9.3 — one wallet under contested balance (20 concurrent BETs) while two
 * independent wallets progress without a global lock (5 concurrent WINs each).
 */
export async function scenarioBalanceContest(ctx: TestContext): Promise<void> {
  logScenarioStart('9.3-balance-contest', ctx.harness);
  const playerA = uuid(10);
  const playerB = uuid(11);
  const playerC = uuid(12);
  const walletA = await createWallet(ctx, playerA, '100.00');
  const walletB = await createWallet(ctx, playerB, '100.00');
  const walletC = await createWallet(ctx, playerC, '100.00');

  const roundId = 'round-93';
  // Staggered 50ms apart: 12 bets still prove contested balance (10 succeed,
  // 2 fail with INSUFFICIENT_FUNDS on a 100.00 wallet) but keep the per-
  // instance pool pressure low enough that independent wallets can progress
  // concurrently without 503 starvation.
  const contest = burstHttp(
    ctx,
    12,
    {
      kind: 'BET',
      providerId: 'prov-93',
      externalTransactionId: 'ext-93-a',
      playerId: playerA,
      walletId: walletA,
      roundId,
      gameId: 'game-93',
      money: { amount: '10.00', currency: 'BRL' },
    },
    50,
  );
  // Stagger WIN bursts to avoid 5-way FOR UPDATE thundering herd on the same
  // wallet row (each holds a DB connection while waiting). 30ms spread keeps
  // the lock queue short and lets the 10-slot pool drain between bursts.
  const independent = [
    ...(await burstHttp(
      ctx,
      5,
      {
        kind: 'WIN',
        providerId: 'prov-93',
        externalTransactionId: 'ext-93-b',
        playerId: playerB,
        walletId: walletB,
        roundId,
        gameId: 'game-93',
        money: { amount: '10.00', currency: 'BRL' },
      },
      30,
    )),
    ...(await burstHttp(
      ctx,
      5,
      {
        kind: 'WIN',
        providerId: 'prov-93',
        externalTransactionId: 'ext-93-c',
        playerId: playerC,
        walletId: walletC,
        roundId,
        gameId: 'game-93',
        money: { amount: '10.00', currency: 'BRL' },
      },
      30,
    )),
  ];
  const contestResults = await contest;
  const independentResults = await Promise.all(independent);
  // eslint-disable-next-line no-console
  console.log(
    `[scenario 9.3] contest statuses: ${JSON.stringify(contestResults.map((r) => r.status))}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[scenario 9.3] independent statuses: ${JSON.stringify(independentResults.map((r) => r.status))}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[scenario 9.3] wager rows for A: ${JSON.stringify(await ctx.invariants.wagerRowsFor(walletA))}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[scenario 9.3] wager rows for B: ${JSON.stringify(await ctx.invariants.wagerRowsFor(walletB))}`,
  );

  // Ledger-derived state for wallet A: processed count + debit sum from the API.
  const aState = await waitFor<{ processed: number; debitSum: string } | null>(
    async () => {
      const ledger = await fetchLedger(walletA);
      const processed = ledger.filter((e) => e.direction === 'DEBIT').length;
      const debitSum = ledger
        .filter((e) => e.direction === 'DEBIT')
        .reduce((sum, e) => sum + parseFloat(e.value.amount), 0);
      if (processed === 0) return null; // contest still serialising
      return { processed, debitSum: debitSum.toFixed(2) };
    },
    15000,
    'wallet A contest to settle',
  );

  // Balance must equal 100 - 10*processed, and the ledger must reconstruct it.
  const settledA = aState as { processed: number; debitSum: string };
  const expectedBalanceA = (100 - 10 * settledA.processed).toFixed(2);
  // Outbox events for wallet A = opening + 2×processed + 1×rejected. The
  // rejected count comes from the DB (some racers may be lost to transient
  // 503s after retries — the DB is the source of truth).
  const aWagerRows = await ctx.invariants.wagerRowsFor(walletA);
  const rejectedA = aWagerRows.filter((r) => r.status === 'REJECTED').length;
  const expectedOutboxA = 1 + settledA.processed * 2 + rejectedA;
  await ctx.invariants.pollUntil(
    walletA,
    {
      balanceAmount: expectedBalanceA,
      ledgerCount: 1 + settledA.processed, // opening + one DEBIT per processed BET
      processedWagerCount: settledA.processed,
      inboxRows: 0, // HTTP path only — no SQS correlation ids for A
      outboxPublished: expectedOutboxA,
      outboxPending: 0,
      walletVersion: 1 + settledA.processed,
    },
    15000,
    '9.3 wallet A invariants',
  );

  for (const walletId of [walletB, walletC]) {
    await ctx.invariants.pollUntil(
      walletId,
      {
        balanceAmount: '150.00', // 100 + 5 × 10 credit
        ledgerCount: 6, // opening + 5 CREDITs
        processedWagerCount: 5,
        inboxRows: 0,
        outboxPublished: 11, // opening + 5×2
        outboxPending: 0,
        walletVersion: 6,
      },
      15000,
      '9.3 independent wallet settlement',
    );
  }

  const fpA = await ctx.invariants.assertFinalInvariants(walletA, {
    balanceAmount: expectedBalanceA,
    ledgerCount: 1 + settledA.processed,
    processedWagerCount: settledA.processed,
    inboxRows: 0,
    outboxPublished: expectedOutboxA,
    outboxPending: 0,
    walletVersion: 1 + settledA.processed,
  });
  const fpB = await ctx.invariants.assertFinalInvariants(walletB, {
    balanceAmount: '150.00',
    ledgerCount: 6,
    processedWagerCount: 5,
    inboxRows: 0,
    outboxPublished: 11,
    outboxPending: 0,
    walletVersion: 6,
  });
  const fpC = await ctx.invariants.assertFinalInvariants(walletC, {
    balanceAmount: '150.00',
    ledgerCount: 6,
    processedWagerCount: 5,
    inboxRows: 0,
    outboxPublished: 11,
    outboxPending: 0,
    walletVersion: 6,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[scenario 9.3] final invariants A=${JSON.stringify(fpA)} B=${JSON.stringify(fpB)} C=${JSON.stringify(fpC)}`,
  );
  // Sanity: some BETs processed AND some rejected (balance 100 cannot fund 12×10).
  if (settledA.processed === 0 || settledA.processed === 12) {
    throw new Error(`9.3 expected a mix of PROCESSED/REJECTED, got ${settledA.processed} processed`);
  }
}

/**
 * 9.4 — deterministic crash after commit, before SQS ack. The fault hook
 * (armed on every instance, since any of them may win the poll race) commits
 * the financial transaction, marks the inbox processed, then exits with 134
 * BEFORE the DeleteMessage. The instance restarts with a fresh PID; the
 * redelivered message is deduplicated by the Inbox — one financial effect.
 */
export async function scenarioCrashAfterCommit(ctx: TestContext): Promise<void> {
  logScenarioStart('9.4-crash-after-commit', ctx.harness);
  const playerP = uuid(20);
  const walletP = await createWallet(ctx, playerP, '100.00');

  // Arm the post-commit fault on every live instance: whichever one receives
  // the crash-test message will die deterministically (exit 134).
  const live = ctx.harness.instances.filter((h) => h.process.exitCode === null);
  for (const h of live) {
    await ctx.harness.restart(h, { afterMessageId: '__ANY__' });
  }

  const crashExternal = `ext-94-crash-${crypto.randomUUID()}`;
  const crashMessageId = await enqueueCommand(ctx, {
    kind: 'BET',
    providerId: 'prov-94',
    externalTransactionId: crashExternal,
    playerId: playerP,
    walletId: walletP,
    roundId: 'round-94',
    gameId: 'game-94',
    money: { amount: '10.00', currency: 'BRL' },
  });

  // Commit must land: balance 90 proves ProcessWager committed and the inbox
  // row is marked processed. Then the fault hook crashed its process.
  await ctx.invariants.pollUntil(
    walletP,
    {
      balanceAmount: '90.00',
      ledgerCount: 2,
      processedWagerCount: 1,
      inboxRows: 1,
      outboxPublished: 3,
      outboxPending: 0,
      walletVersion: 2,
    },
    15000,
    '9.4 commit before crash',
    [crashMessageId],
  );

  // Exactly one instance must have died (the one that processed the message).
  const crashed = ctx.harness.instances.find((h) => h.process.exitCode !== null);
  if (!crashed) {
    throw new Error('9.4 expected exactly one instance to crash with the fault');
  }
  // eslint-disable-next-line no-console
  console.log(
    `[scenario 9.4] crashed instance ${crashed.instanceId} pid=${crashed.pid} exitCode=${crashed.process.exitCode}`,
  );
  const oldPid = crashed.pid;
  if (crashed.process.exitCode !== 134) {
    // Safety net only; the fault path exits 134 deterministically.
    await ctx.harness.sendSignal(crashed, 'SIGKILL');
    await ctx.harness.awaitExit(crashed, 5000);
  }
  // Restart the crashed instance clean (fault cleared) on the same port.
  const reborn = await ctx.harness.restart(crashed);

  // Visibility timeout (2s) redelivers; the restarted process (or another
  // instance) dedupes via the inbox row: same messageId, processed_at set.
  const finalFp = await ctx.invariants.pollUntil(
    walletP,
    {
      balanceAmount: '90.00',
      ledgerCount: 2,
      processedWagerCount: 1,
      inboxRows: 1,
      outboxPublished: 3,
      outboxPending: 0,
      walletVersion: 2,
    },
    15000,
    '9.4 redelivery deduped',
    [crashMessageId],
  );
  await ctx.invariants.assertFinalInvariants(
    walletP,
    {
      balanceAmount: '90.00',
      ledgerCount: 2,
      processedWagerCount: 1,
      inboxRows: 1,
      outboxPublished: 3,
      outboxPending: 0,
      walletVersion: 2,
    },
    [crashMessageId],
  );
  // eslint-disable-next-line no-console
  console.log(`[scenario 9.4] final invariants: ${JSON.stringify(finalFp)}`);
  if (reborn.pid === oldPid) {
    throw new Error(`9.4 expected a fresh PID after restart, got ${reborn.pid}`);
  }
  // Un-arm the two surviving instances so no later message crashes them.
  for (const h of ctx.harness.instances) {
    if (h !== reborn && h.process.exitCode === null) {
      await ctx.harness.restart(h);
    }
  }
}

/**
 * 9.5 — out-of-order reversal: REFUND enqueued before its BET reference. It
 * lands PENDING_REFERENCE; the worker resolves it once the BET commits. Two
 * publisher instances run concurrently over the same outbox; the pre-publish
 * fault on instance 1 proves SKIP LOCKED hands the row to another instance
 * with no double-publish. Final restart keeps every invariant.
 */
export async function scenarioConcurrentOutbox(ctx: TestContext): Promise<void> {
  logScenarioStart('9.5-concurrent-outbox', ctx.harness);
  const playerQ = uuid(30);
  const walletQ = await createWallet(ctx, playerQ, '100.00');

  // Arm instance 1's pre-publish fault against a real PENDING outbox event of
  // this wallet (the opening WalletBalanceChanged, created just above). When
  // instance 1's publisher claims that row, it throws before SendMessage and
  // rolls the claim back — instance 2 (or 3) must then publish it: the SKIP
  // LOCKED handover with no double-publish.
  const armedEventId = await ctx.invariants.pendingOutboxEventIdFor(walletQ);
  if (!armedEventId) throw new Error('9.5 expected a PENDING outbox row after wallet creation');
  const instance1 = ctx.harness.instances[0]!;
  await ctx.harness.restart(instance1, { prePublishEventId: armedEventId });

  const betExt = `ext-95-bet-${crypto.randomUUID()}`;
  const refundExt = `ext-95-refund-${crypto.randomUUID()}`;
  // REFUND first, then the BET it references — both via SQS.
  const refundMessageId = await enqueueCommand(ctx, {
    kind: 'REFUND',
    providerId: 'prov-95',
    externalTransactionId: refundExt,
    playerId: playerQ,
    walletId: walletQ,
    roundId: 'round-95',
    gameId: 'game-95',
    money: { amount: '10.00', currency: 'BRL' },
    referenceExternalTransactionId: betExt,
  });
  const betMessageId = await enqueueCommand(ctx, {
    kind: 'BET',
    providerId: 'prov-95',
    externalTransactionId: betExt,
    playerId: playerQ,
    walletId: walletQ,
    roundId: 'round-95',
    gameId: 'game-95',
    money: { amount: '10.00', currency: 'BRL' },
  });
  const qMessageIds = [refundMessageId, betMessageId];

  // PENDING_REFERENCE must be observable before the BET resolves it. Query by
  // the real external id (UUID-suffixed) — the literal prefix never matches.
  await waitFor<unknown>(
    async () => {
      const r = await ctx.invariants.queryWagerStatus(refundExt);
      return r === 'PENDING_REFERENCE' ? true : null;
    },
    10000,
    'REFUND to land PENDING_REFERENCE',
  );

  // Worker resolves the REFUND after the BET commits → balance back to 100.
  // opening (1) + BET (2) + REFUND PENDING (1) + REFUND resolved extra (2) = 6
  const finalFp = await ctx.invariants.pollUntil(
    walletQ,
    {
      balanceAmount: '100.00',
      ledgerCount: 3, // opening + BET debit + REFUND credit
      processedWagerCount: 2, // BET + resolved REFUND
      inboxRows: 2,
      outboxPublished: 6, // opening + 2×BET + 1×PENDING + 2×resolved
      outboxPending: 0,
      walletVersion: 3,
    },
    30000,
    '9.5 out-of-order reversal resolved',
    qMessageIds,
  );
  // eslint-disable-next-line no-console
  console.log(`[scenario 9.5] final invariants: ${JSON.stringify(finalFp)}`);

  // Every walletQ outbox row must be PUBLISHED with attempts==1 — proof that
  // the two concurrent publishers never double-published (SKIP LOCKED).
  const rows = await ctx.invariants.outboxRowsFor(walletQ);
  for (const row of rows) {
    if (row.status !== 'PUBLISHED' || row.attempts !== 1) {
      throw new Error(
        `9.5 outbox row ${row.event_id} status=${row.status} attempts=${row.attempts} — expected PUBLISHED/1`,
      );
    }
  }

  // Restart one instance after REFUND commit + publish: state must not move.
  await ctx.harness.restart(ctx.harness.instances[1]!);
  const afterRestart = await ctx.invariants.pollUntil(
    walletQ,
    {
      balanceAmount: '100.00',
      ledgerCount: 3,
      processedWagerCount: 2,
      inboxRows: 2,
      outboxPublished: 6,
      outboxPending: 0,
      walletVersion: 3,
    },
    15000,
    '9.5 invariants after instance restart',
    qMessageIds,
  );
  // eslint-disable-next-line no-console
  console.log(`[scenario 9.5] post-restart invariants: ${JSON.stringify(afterRestart)}`);
}

/** Minimal ledger entry shape returned by GET /wallets/:id/ledger. */
interface LedgerEntryDto {
  direction: 'DEBIT' | 'CREDIT';
  value: { amount: string; currency: string };
  [k: string]: unknown;
}

async function fetchLedger(walletId: string): Promise<LedgerEntryDto[]> {
  const res = await fetch(`http://127.0.0.1:3101/wallets/${walletId}/ledger?limit=100`);
  if (res.status !== 200) throw new Error(`ledger fetch failed: ${res.status}`);
  const body = (await res.json()) as { entries?: LedgerEntryDto[] };
  return body.entries ?? [];
}
