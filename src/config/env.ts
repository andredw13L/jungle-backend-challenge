import { z } from 'zod';

/**
 * Runtime configuration for the wagering processor.
 *
 * Validated eagerly at boot, before NestJS starts listening. The schema
 * rejects missing/invalid values with an explicit message that never echoes
 * secrets — see the operational-readiness spec.
 */

// ponytail: a single zod object is the smallest thing that covers every
// validation we need; no point layering a config library on top.
const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('false'),
  AWS_REGION: z.string().min(1, 'AWS_REGION is required'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  QUEUE_COMMAND: z.string().min(1).endsWith('.fifo'),
  QUEUE_COMMAND_DLQ: z.string().min(1).endsWith('.fifo'),
  QUEUE_EVENTS: z.string().min(1).endsWith('.fifo'),
  SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
  SQS_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_VISIBILITY_SECONDS: z.coerce.number().int().min(1).max(43200).default(60),
  CONSUMER_DLQ_MAX_RECEIVES: z.coerce.number().int().min(1).max(100).default(5),
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(32).default(8),
  RETRY_BASE_SECONDS: z.coerce.number().int().min(1).max(60).default(1),
  RETRY_MAX_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
});

export type AppEnv = z.infer<typeof EnvSchema>;

/**
 * Validate process.env, returning a frozen AppEnv. Throws a structured
 * error listing the failing variable names — never their values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid runtime configuration: ${issues}`);
  }
  return Object.freeze(result.data);
}

/**
 * Test-only constructor. Mirrors loadEnv but with overridable defaults so
 * unit tests do not have to populate every variable.
 */
export function makeEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): AppEnv {
  return loadEnv({
    PORT: '3101',
    DATABASE_URL: 'postgres://u:p@localhost:5544/w',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    QUEUE_COMMAND: 'wager-transactions.fifo',
    QUEUE_COMMAND_DLQ: 'wager-transactions-dlq.fifo',
    QUEUE_EVENTS: 'wager-events.fifo',
    ...overrides,
  });
}