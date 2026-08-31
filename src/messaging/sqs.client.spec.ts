import { describe, expect, test } from 'bun:test';
import { queueUrl, sqsPing } from './sqs.client';
import type { AppEnv } from '../config/env';

/**
 * Pure-function tests over the SQS URL builder and a mock client.
 *
 * Slice 1 does not need a live LocalStack; the indicator-level integration
 * with the broker is asserted via the readiness script + the readiness
 * test in slice 9.
 */
describe('sqs.client', () => {
  const env: AppEnv = {
    PORT: 3101,
    DATABASE_URL: 'postgres://u:p@localhost:5544/w',
    DATABASE_SSL: false,
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL: 'http://localhost:4566',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    QUEUE_COMMAND: 'wager-transactions.fifo',
    QUEUE_COMMAND_DLQ: 'wager-transactions-dlq.fifo',
    QUEUE_EVENTS: 'wager-events.fifo',
    SQS_MAX_MESSAGES: 10,
    SQS_WAIT_SECONDS: 20,
    SQS_VISIBILITY_SECONDS: 60,
    CONSUMER_DLQ_MAX_RECEIVES: 5,
    RETRY_MAX_ATTEMPTS: 8,
    RETRY_BASE_SECONDS: 1,
    RETRY_MAX_SECONDS: 60,
    LOG_LEVEL: 'info',
    SHUTDOWN_TIMEOUT_MS: 15000,
  };

  test('queueUrl builds the localstack URL with the fixed account id', () => {
    expect(queueUrl(env, 'wager-events.fifo')).toBe(
      'http://localhost:4566/000000000000/wager-events.fifo',
    );
  });

  test('sqsPing forwards the GetQueueAttributes command', async () => {
    let called = false;
    const fakeClient = {
      send: async () => {
        called = true;
        return { Attributes: { ApproximateNumberOfMessages: '0' } };
      },
    } as unknown as Parameters<typeof sqsPing>[0];
    await sqsPing(fakeClient, 'http://x/y/z');
    expect(called).toBe(true);
  });
});