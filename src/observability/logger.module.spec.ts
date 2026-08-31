import { describe, expect, test } from 'bun:test';

describe('HTTP request serializer', () => {
  test('retains request identity but never serializes headers', async () => {
    const originalEnv = { ...process.env };
    Object.assign(process.env, {
      PORT: '3101',
      DATABASE_URL: 'postgres://u:p@localhost:5544/w',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      QUEUE_COMMAND: 'wager-transactions.fifo',
      QUEUE_COMMAND_DLQ: 'wager-transactions-dlq.fifo',
      QUEUE_EVENTS: 'wager-events.fifo',
    });
    try {
      const module = (await import('./logger.module')) as typeof import('./logger.module') & {
        serializeHttpRequest?: (request: Record<string, unknown>) => Record<string, unknown>;
      };
      expect(typeof module.serializeHttpRequest).toBe('function');
      if (!module.serializeHttpRequest) return;
      const serialized = module.serializeHttpRequest({
        id: 'request-1',
        method: 'POST',
        url: '/wagering/transactions',
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'x-api-key': 'secret',
          'idempotency-key': 'provider:transaction',
        },
      });
      expect(serialized).toEqual({ id: 'request-1', method: 'POST', url: '/wagering/transactions' });
      expect(JSON.stringify(serialized)).not.toMatch(/authorization|cookie|api-key|idempotency/i);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  });
});
