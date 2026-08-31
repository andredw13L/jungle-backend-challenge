import { describe, expect, test } from 'bun:test';
import { parseMessageBody } from './command-message-handler';

const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data,
    ...overrides,
  });
}

describe('SQS command envelope', () => {
  test('accepts the official envelope and exposes walletId from data', () => {
    const parsed = parseMessageBody(envelope());
    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.data.walletId).toBe(data.walletId);
    expect(parsed.data.money.amount).toBe('25.00');
  });

  test('rejects a flat payload, wrong type, and unknown envelope or data fields', () => {
    expect(() => parseMessageBody(JSON.stringify(data))).toThrow();
    expect(() => parseMessageBody(envelope({ type: 'OtherMessage' }))).toThrow();
    expect(() => parseMessageBody(envelope({ extra: true }))).toThrow();
    expect(() => parseMessageBody(envelope({ data: { ...data, extra: true } }))).toThrow();
  });

  test('reuses business validation for invalid identifiers, money, and references', () => {
    expect(() => parseMessageBody(envelope({ data: { ...data, playerId: 'not-a-uuid' } }))).toThrow();
    expect(() => parseMessageBody(envelope({ data: { ...data, money: { amount: '25.001', currency: 'BRL' } } }))).toThrow();
    expect(() => parseMessageBody(envelope({ data: { ...data, kind: 'REFUND' } }))).toThrow();
  });

  test('rejects an invalid idempotency key with the shared HTTP boundary', () => {
    expect(() => parseMessageBody(envelope({
      data: { ...data, idempotencyKey: 'x'.repeat(257) },
    }))).toThrow();
  });
});
