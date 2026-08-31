import { describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { makeEnv } from '../src/config/env';
import { ensureQueue } from './readiness';

describe('queue readiness', () => {
  test('repairs an existing command queue redrive policy to five receives', async () => {
    const sent: object[] = [];
    const sqs = {
      send: async (command: object) => {
        sent.push(command);
        if (command instanceof GetQueueAttributesCommand) {
          return {
            Attributes: {
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:wrong-dlq.fifo',
                maxReceiveCount: '3',
              }),
            },
          };
        }
        return {};
      },
    } as unknown as SQSClient;

    const result = await ensureQueue(sqs, makeEnv(), 'wager-transactions.fifo', 'command');

    expect(result).toMatchObject({ ok: true, detail: 'updated redrive maxReceiveCount=5' });
    const update = sent.find((command) => command instanceof SetQueueAttributesCommand) as SetQueueAttributesCommand;
    expect(update.input.Attributes?.RedrivePolicy).toBe(JSON.stringify({
      deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo',
      maxReceiveCount: 5,
    }));
  });
});
