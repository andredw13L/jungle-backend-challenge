import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { IsolationLevel } from '@mikro-orm/core';
import { z } from 'zod';
import { MIKRO_ORM } from '../infrastructure/database/entities';
import type { AppOrm } from '../infrastructure/database/orm.module';
import type { LoggerLike, SqsMessage } from './command-consumer';
import { CONSUMER_NAME, InboxRepository } from './inbox.repository';
import { MetricsService } from '../observability/metrics.service';
import { payloadHash } from '../domain/canonical-json';
import { WagerInfrastructureError } from '../domain/errors';
import type { AppEnv } from '../config/env';
import { ProcessWager } from '../wagering/process-wager';
import { wagerPayloadHash } from '../wagering/wager.repository';
import {
  normalizeSqsWager,
  SqsWagerDataSchema,
  type SqsWagerDataDto,
} from '../wagering/dto/submit-wager.dto';
import type { SubmitWagerInput } from '../wagering/process-wager.types';
import { maybeInjectPostCommitFault } from './test-hooks';

/**
 * SQS message body shape — see README §10. The business data is validated by
 * the same schema and normalizer used by the HTTP adapter.
 */
export interface WagerTransactionRequested {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: SqsWagerDataDto;
}

/** SQS action the consumer takes for a handled message. */
export type HandleAction = 'ack' | 'redeliver';

/** Internal signal that aborts the shared transaction but leaves SQS unacked. */
class LeaveUnacknowledgedError extends Error {
  constructor() {
    super('message processing did not commit');
    this.name = 'LeaveUnacknowledgedError';
  }
}

/**
 * CommandMessageHandler — turns one SQS message into a business outcome
 * through the shared ProcessWager, recording delivery accounting in the
 * Inbox. Returns the SQS action: ack (business result/duplicate) or redeliver
 * (transient/permanent failure — let the queue redrive policy decide).
 *
 * Inbox, ProcessWager and `markProcessed` share one READ COMMITTED
 * transaction. The SQS acknowledgement is performed by CommandConsumer only
 * after this method has returned successfully.
 */
@Injectable()
export class CommandMessageHandler {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: Promise<AppOrm>,
    private readonly inbox: InboxRepository,
    private readonly processWager: ProcessWager,
    private readonly metrics: MetricsService,
    @Inject('APP_ENV') _env: AppEnv,
    private readonly logger: LoggerLike,
  ) {}

  async process(message: SqsMessage): Promise<HandleAction> {
    const transportMessageId = message.MessageId ?? 'unknown';
    let parsed: WagerTransactionRequested;
    let bodyHash: string;
    let submit!: SubmitWagerInput;
    try {
      parsed = parseMessageBody(message.Body ?? '');
      submit = normalizeSqsWager(parsed.data, parsed.messageId);
      bodyHash = businessBodyHash(submit);
    } catch {
      // Malformed / invalid payload → leave unacknowledged. SQS redrive,
      // rather than an application counter, decides when it reaches the DLQ.
      return this.permanent(transportMessageId, payloadHash(message.Body ?? ''), null, 'INVALID_PAYLOAD');
    }
    const messageId = parsed.messageId;
    const correlationId = parsed.messageId;

    const orm = await this.orm;
    const start = performance.now();
    let logOutcome: string | undefined;
    let logResult: SubmitWagerInput | undefined;
    try {
      const result = await orm.em.fork().transactional(async (em) => {
        const claim = await this.inbox.upsert(em, CONSUMER_NAME, messageId, bodyHash, correlationId);
        if (claim.bodyHash !== bodyHash) {
          return { action: this.permanentFromCount(messageId, claim.receivedCount, 'IDEMPOTENCY_CONFLICT', submit), result: null };
        }
        if (claim.processed) {
          this.metrics.recordInboxReceived('duplicate');
          return { action: 'ack' as const, result: null };
        }
        try {
          const processed = await this.processWager.execute(submit, em);
          await this.inbox.markProcessed(em, CONSUMER_NAME, messageId);
          logOutcome = processed.idempotentReplay
            ? 'duplicate'
            : processed.status === 'REJECTED'
              ? 'rejected'
              : 'processed';
          logResult = submit;
          return { action: 'ack' as const, result: processed };
        } catch (err) {
          if (isTransientError(err)) {
            this.metrics.recordInboxReceived('retried');
            this.logger.warn({ messageId, correlationId, walletId: submit.walletId, providerId: submit.providerId }, 'transient failure — will be redelivered');
            throw new LeaveUnacknowledgedError();
          }
          this.permanentFromCount(messageId, claim.receivedCount, errorCode(err) ?? 'PERMANENT', submit);
          throw new LeaveUnacknowledgedError();
        }
      }, { isolationLevel: IsolationLevel.READ_COMMITTED });
      if (logOutcome && logResult) {
        this.metrics.recordInboxReceived(logOutcome);
        this.logger.log({
          messageId,
          correlationId,
          transactionId: result.result?.transactionId,
          walletId: logResult.walletId,
          providerId: logResult.providerId,
          outcome: logOutcome,
        }, 'wager command processed');
      }
      // TEST-ONLY fault injection (slice 9.4): after the shared transaction
      // commits, before the SQS DeleteMessage.
      if (result.action === 'ack' && result.result) await maybeInjectPostCommitFault(messageId);
      return result.action;
    } catch (err) {
      if (err instanceof LeaveUnacknowledgedError) return 'redeliver';
      if (isTransientError(err)) {
        this.metrics.recordInboxReceived('retried');
        this.logger.warn({ messageId, correlationId, walletId: submit.walletId, providerId: submit.providerId }, 'transient failure — will be redelivered');
        return 'redeliver';
      }
      return this.permanentFromCount(messageId, 0, errorCode(err) ?? 'PERMANENT', submit);
    } finally {
      this.metrics.observeConsumerProcessing((performance.now() - start) / 1000);
    }
  }

  /** Permanent failure for a message whose body could not be parsed at all. */
  private async permanent(
    messageId: string,
    bodyHash: string,
    correlationId: string | null,
    code: string,
  ): Promise<HandleAction> {
    const orm = await this.orm;
    const claim = await orm.em.fork().transactional((em) =>
      this.inbox.upsert(em, CONSUMER_NAME, messageId, bodyHash, correlationId),
    );
    return this.permanentFromCount(messageId, claim.receivedCount, code);
  }

  private permanentFromCount(
    messageId: string,
    receivedCount: number,
    code: string,
    input?: SubmitWagerInput,
  ): HandleAction {
    this.metrics.recordInboxReceived('permanent');
    this.logger.warn({
      messageId,
      code,
      receivedCount,
      ...(input ? { correlationId: input.correlationId, walletId: input.walletId, providerId: input.providerId } : {}),
    }, 'permanent failure — leaving unacknowledged for SQS redrive');
    return 'redeliver';
  }
}

export function parseMessageBody(raw: string): WagerTransactionRequested {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new UnprocessableEntityException({ code: 'INVALID_PAYLOAD' });
  }
  const parsed = z.object({
    messageId: z.string().min(1).max(256),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.string().datetime({ offset: true }),
    data: SqsWagerDataSchema,
  }).strict().safeParse(body);
  if (!parsed.success) throw new UnprocessableEntityException({ code: 'INVALID_PAYLOAD' });
  return parsed.data;
}

/** Business-field body hash — same scheme as wagerPayloadHash. */
export function businessBodyHash(body: SubmitWagerInput): string {
  return wagerPayloadHash(body);
}

function errorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: string; response?: { code?: string }; cause?: unknown };
  if (typeof e.code === 'string') return e.code;
  if (typeof e.response?.code === 'string') return e.response.code;
  return errorCode(e.cause);
}

function isTransientError(err: unknown): boolean {
  if (err instanceof WagerInfrastructureError) return true;
  if (err instanceof UnprocessableEntityException) return false;
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; cause?: unknown; message?: string };
  if (e.code && ['40001', '08000', '08003', '08006', '57P01', '57P03'].includes(e.code)) return true;
  if (typeof e.message === 'string' && /ECONNRESET|ECONNREFUSED|connection terminated|timed out|timeout/i.test(e.message)) {
    return true;
  }
  return isTransientError(e.cause);
}
