import { describe, expect, test } from 'bun:test';
import { loadEnv, makeEnv } from './env';

describe('env', () => {
  test('accepts a fully populated configuration', () => {
    const env = makeEnv();
    expect(env.PORT).toBe(3101);
    expect(env.QUEUE_COMMAND.endsWith('.fifo')).toBe(true);
    expect(env.SQS_MAX_MESSAGES).toBe(10);
    expect(env.SQS_VISIBILITY_SECONDS).toBe(60);
  });

  test('rejects a missing DATABASE_URL without printing values', () => {
    expect(() => loadEnv({ PORT: '3101', AWS_REGION: 'us-east-1' })).toThrow(
      /DATABASE_URL/,
    );
  });

  test('rejects an invalid PORT', () => {
    expect(() =>
      loadEnv({ PORT: '0', DATABASE_URL: 'postgres://x', AWS_REGION: 'us-east-1' }),
    ).toThrow(/PORT/);
  });

  test('rejects queue names that are not FIFO', () => {
    expect(() =>
      makeEnv({ QUEUE_COMMAND: 'wager-transactions' }),
    ).toThrow(/fifo/);
  });

  test('coerces numeric strings and respects defaults', () => {
    const env = makeEnv({ PORT: '3102', SQS_MAX_MESSAGES: '5' });
    expect(env.PORT).toBe(3102);
    expect(env.SQS_MAX_MESSAGES).toBe(5);
    expect(env.SQS_WAIT_SECONDS).toBe(20);
  });

  test('rejects out-of-range retry settings', () => {
    expect(() => makeEnv({ RETRY_MAX_ATTEMPTS: '0' })).toThrow(
      /RETRY_MAX_ATTEMPTS/,
    );
    expect(() => makeEnv({ RETRY_BASE_SECONDS: '0' })).toThrow(
      /RETRY_BASE_SECONDS/,
    );
  });
});