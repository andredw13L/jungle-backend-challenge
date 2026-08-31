import { expect, test } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { makeEnv } from '../config/env';
import { MetricsService } from '../observability/metrics.service';
import { ConsumerShutdown } from './consumer-shutdown';
import { CommandConsumer, type LoggerLike } from './command-consumer';

const logger: LoggerLike = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

test('groups overlap across wallets while preserving order within one wallet', async () => {
  const messages = [
    { MessageId: 'a1', Body: JSON.stringify({ data: { walletId: 'wallet-a' } }), ReceiptHandle: 'r-a1' },
    { MessageId: 'a2', Body: JSON.stringify({ data: { walletId: 'wallet-a' } }), ReceiptHandle: 'r-a2' },
    { MessageId: 'b1', Body: JSON.stringify({ data: { walletId: 'wallet-b' } }), ReceiptHandle: 'r-b1' },
  ];
  let releaseA!: () => void;
  const blockedA = new Promise<void>((resolve) => { releaseA = resolve; });
  let walletBStarted!: () => void;
  const startedB = new Promise<void>((resolve) => { walletBStarted = resolve; });
  const started: string[] = [];
  const processed: string[] = [];
  const handler = {
    process: async (message: { MessageId?: string }) => {
      const id = message.MessageId!;
      started.push(id);
      if (id === 'a1') await blockedA;
      if (id === 'b1') walletBStarted();
      processed.push(id);
      return 'ack' as const;
    },
  };
  const client = {
    send: async (command: unknown) =>
      command instanceof ReceiveMessageCommand ? { Messages: messages } : {},
  };
  const consumer = new CommandConsumer(
    client as never,
    makeEnv({ SQS_WAIT_SECONDS: '0' }),
    handler as never,
    new ConsumerShutdown(makeEnv()),
    new MetricsService(),
    logger,
  );

  const polling = consumer.pollOnce();
  await startedB;
  expect(started).toEqual(['a1', 'b1']);
  expect(processed).toEqual(['b1']);
  releaseA();
  await polling;
  expect(processed).toEqual(['b1', 'a1', 'a2']);
});

test('leaves a permanent failure untouched for the queue redrive policy', async () => {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      return command instanceof ReceiveMessageCommand
        ? { Messages: [{ MessageId: 'bad', Body: '{}', ReceiptHandle: 'receipt' }] }
        : { Attributes: { ApproximateNumberOfMessages: '0' } };
    },
  };
  const consumer = new CommandConsumer(
    client as never,
    makeEnv({ SQS_WAIT_SECONDS: '0' }),
    { process: async () => 'redeliver' as const } as never,
    new ConsumerShutdown(makeEnv()),
    new MetricsService(),
    logger,
  );

  await consumer.pollOnce();

  expect(sent.some((command) => command instanceof DeleteMessageCommand)).toBe(false);
  expect(sent).toHaveLength(2); // ReceiveMessage + DLQ depth observation only.
});

test('does not process a batch when shutdown starts after ReceiveMessage', async () => {
  let processed = 0;
  const shutdown = new ConsumerShutdown(makeEnv({ SQS_WAIT_SECONDS: '0' }));
  const client = {
    send: async (command: unknown) => {
      if (command instanceof ReceiveMessageCommand) {
        shutdown.signalShutdown();
        return { Messages: [{ MessageId: 'received-during-shutdown', Body: '{}', ReceiptHandle: 'receipt' }] };
      }
      return { Attributes: { ApproximateNumberOfMessages: '0' } };
    },
  };
  const consumer = new CommandConsumer(
    client as never,
    makeEnv({ SQS_WAIT_SECONDS: '0' }),
    { process: async () => { processed++; return 'ack' as const; } } as never,
    shutdown,
    new MetricsService(),
    logger,
  );

  await consumer.pollOnce();

  expect(processed).toBe(0);
});
