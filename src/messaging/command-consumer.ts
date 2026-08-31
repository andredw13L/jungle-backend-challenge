import { Inject, Injectable } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppEnv } from '../config/env';
import { queueUrl } from './sqs.client';
import type { CommandMessageHandler, HandleAction } from './command-message-handler';
import { ConsumerShutdown } from './consumer-shutdown';
import { MetricsService } from '../observability/metrics.service';

export type SqsMessage = Pick<Message, 'MessageId' | 'Body' | 'ReceiptHandle'>;

/** Structural logger — satisfied by both the nestjs-pino Logger and a raw pino logger. */
export interface LoggerLike {
  log(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

/**
 * CommandConsumer — long-polls `wager-transactions.fifo`, groups the batch by
 * walletId, and processes groups concurrently while preserving FIFO order
 * within each group. It ack/redelivers/DLQ-redirects based on the handler's
 * outcome. No work-queue library: a per-group promise chain is all we need.
 */
@Injectable()
export class CommandConsumer {
  private readonly queueUrl: string;
  private inflight = 0;

  constructor(
    @Inject('SQS_CLIENT') private readonly client: SQSClient,
    @Inject('APP_ENV') private readonly env: AppEnv,
    private readonly handler: CommandMessageHandler,
    private readonly shutdown: ConsumerShutdown,
    private readonly metrics: MetricsService,
    private readonly logger: LoggerLike,
  ) {
    this.queueUrl = queueUrl(this.env, this.env.QUEUE_COMMAND);
  }

  /** Blocking polling loop; returns when shutdown is signalled. */
  async start(): Promise<void> {
    this.logger.log({}, 'command consumer started');
    while (!this.shutdown.isShuttingDown()) {
      await this.pollOnce();
    }
    this.logger.log({}, 'command consumer stopped');
  }

  /** One receive + process cycle. Testable directly. */
  async pollOnce(): Promise<void> {
    if (this.shutdown.isShuttingDown()) return;
    let messages: SqsMessage[];
    try {
      const res = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: this.env.SQS_MAX_MESSAGES,
          WaitTimeSeconds: this.env.SQS_WAIT_SECONDS,
          VisibilityTimeout: this.env.SQS_VISIBILITY_SECONDS,
        }),
      );
      messages = (res.Messages ?? []).map((m) => ({
        MessageId: m.MessageId,
        Body: m.Body,
        ReceiptHandle: m.ReceiptHandle,
      }));
    } catch (err) {
      // Transient broker failure — log and let the next poll retry.
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'sqs receive failed');
      return;
    }
    if (messages.length > 0) {
      await this.processBatch(messages);
    }
  }

  /**
   * Group by walletId (unparseable bodies become their own singleton group).
   * Groups run concurrently; within a group messages stay sequential.
   */
  private async processBatch(messages: SqsMessage[]): Promise<void> {
    const groups = new Map<string, SqsMessage[]>();
    for (const m of messages) {
      const key = walletKey(m) ?? `__singleton__${m.MessageId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  private async processGroup(group: SqsMessage[]): Promise<void> {
    for (const message of group) {
      await this.processMessage(message);
    }
  }

  private async processMessage(message: SqsMessage): Promise<void> {
    this.inflight++;
    this.shutdown.beginWork();
    this.metrics.setConsumerInflight(this.inflight);
    try {
      const action = await this.handler.process(message);
      await this.applyAction(message, action);
    } catch (err) {
      // Ack/visibility failure: leave the message to the visibility timeout.
      this.logger.warn({ messageId: message.MessageId }, 'sqs ack failed — will be redelivered');
    } finally {
      this.inflight--;
      this.shutdown.endWork();
      this.metrics.setConsumerInflight(this.inflight);
    }
  }

  private async applyAction(message: SqsMessage, action: HandleAction): Promise<void> {
    if (!message.ReceiptHandle) return;
    if (action === 'ack') {
      await this.client.send(
        new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    } else if (action === 'redirect-dlq') {
      // Make it visible again immediately so SQS's redrive policy (max
      // receive count) routes it to the DLQ quickly.
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }
    // 'redeliver' → leave untouched; visibility timeout redelivers.
  }
}

function walletKey(message: SqsMessage): string | null {
  try {
    const body = JSON.parse(message.Body ?? '') as { walletId?: unknown };
    return typeof body.walletId === 'string' ? body.walletId : null;
  } catch {
    return null;
  }
}
