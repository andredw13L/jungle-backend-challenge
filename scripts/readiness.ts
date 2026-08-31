/**
 * Readiness script — idempotent provisioning for slice 1.
 *
 * 1. Verifies PostgreSQL 18 is reachable and `uuidv7()` is available (native
 *    function, provided by PostgreSQL 18). Used by slice 3 but proved here
 *    so a stale engine image fails fast.
 * 2. Creates the three mandatory FIFO queues with content-based
 *    deduplication: wager-transactions.fifo, wager-transactions-dlq.fifo
 *    and wager-events.fifo. Existing queues are left intact.
 *
 * Order matters: the DLQ must exist before the command queue references it
 * in its RedrivePolicy, and the events queue has no redrive at all.
 */
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { loadEnv, type AppEnv } from '../src/config/env';
import { queueUrl } from '../src/messaging/sqs.client';

type Check = { name: string; ok: boolean; detail?: string };

async function checkPostgres(env: AppEnv): Promise<Check> {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    const version = await client.query<{ server_version: string }>(
      'SHOW server_version',
    );
    const uuidV7 = await client.query<{ ok: number }>(
      "SELECT 1 AS ok FROM pg_proc WHERE proname = 'uuidv7'",
    );
    const supportsUuidV7 = (uuidV7.rowCount ?? 0) > 0;
    return {
      name: 'postgres',
      ok: supportsUuidV7,
      detail: `server=${version.rows[0]?.server_version}; uuidv7()=${
        supportsUuidV7 ? 'available' : 'missing'
      }`,
    };
  } catch (err) {
    return {
      name: 'postgres',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

type QueueKind = 'command' | 'dlq' | 'events';

export async function ensureQueue(
  sqs: SQSClient,
  env: AppEnv,
  name: string,
  kind: QueueKind,
): Promise<Check> {
  try {
    const attributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl(env, name),
      ...(kind === 'command' ? { AttributeNames: ['RedrivePolicy'] } : {}),
    }));
    if (kind === 'command') {
      const rawPolicy = attributes.Attributes?.RedrivePolicy;
      let policy: { deadLetterTargetArn?: string; maxReceiveCount?: string | number } = {};
      try {
        policy = rawPolicy ? JSON.parse(rawPolicy) as typeof policy : {};
      } catch {
        // Treat malformed policy like a missing one and repair it below.
      }
      const expectedArn = `arn:aws:sqs:${env.AWS_REGION}:000000000000:${dlqNameFor(name)}`;
      if (policy.deadLetterTargetArn !== expectedArn || Number(policy.maxReceiveCount) !== 5) {
        await sqs.send(new SetQueueAttributesCommand({
          QueueUrl: queueUrl(env, name),
          Attributes: {
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: expectedArn,
              maxReceiveCount: 5,
            }),
          },
        }));
        return { name, ok: true, detail: 'updated redrive maxReceiveCount=5' };
      }
    }
    return { name, ok: true, detail: 'exists' };
  } catch {
    // fall through to creation
  }

  const attributes: NonNullable<
    ConstructorParameters<typeof CreateQueueCommand>[0]
  >['Attributes'] = {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'true',
  };

  if (kind === 'dlq') {
    attributes.MessageRetentionPeriod = '1209600'; // 14 days
  } else if (kind === 'command') {
    const dlqName = dlqNameFor(name);
    const dlqArn = `arn:aws:sqs:${env.AWS_REGION}:000000000000:${dlqName}`;
    attributes.RedrivePolicy = JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: 5,
    });
  }
  // 'events' queues get no extra attributes.

  try {
    await sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    );
    return { name, ok: true, detail: 'created' };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function dlqNameFor(commandQueue: string): string {
  return commandQueue.replace(/\.fifo$/, '-dlq.fifo');
}

async function checkSqs(env: AppEnv): Promise<Check[]> {
  const sqsConfig: ConstructorParameters<typeof SQSClient>[0] = {
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  };
  if (env.AWS_ENDPOINT_URL) sqsConfig.endpoint = env.AWS_ENDPOINT_URL;
  const sqs = new SQSClient(sqsConfig);

  // DLQ must exist before the command queue references it.
  const dlq = await ensureQueue(sqs, env, env.QUEUE_COMMAND_DLQ, 'dlq');
  const command = await ensureQueue(sqs, env, env.QUEUE_COMMAND, 'command');
  const events = await ensureQueue(sqs, env, env.QUEUE_EVENTS, 'events');
  return [dlq, command, events];
}

async function main(): Promise<void> {
  const env = loadEnv();
  const checks: Check[] = [];
  checks.push(await checkPostgres(env));
  checks.push(...(await checkSqs(env)));

  // ponytail: a single loop + exit code is plenty here; no pretty table.
  let ok = true;
  for (const c of checks) {
    const mark = c.ok ? '✓' : '✗';
    // eslint-disable-next-line no-console
    console.log(`${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.ok) ok = false;
  }
  if (!ok) process.exit(1);
}

if (import.meta.main) await main();
