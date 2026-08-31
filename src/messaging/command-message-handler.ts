import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
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
import type { SubmitWagerInput, WagerKind } from '../wagering/process-wager.types';

/**
 * SQS message body shape — see the reliable-messaging spec. Transport
 * metadata (idempotencyKey, correlationId) is excluded from the body hash
 * (same scheme as wagerPayloadHash).
 */
export interface WagerTransactionRequested {
  kind: WagerKind;
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

/** SQS action the consumer takes for a handled message. */
export type HandleAction = 'ack' | 'redeliver' | 'redirect-dlq';

/**
 * CommandMessageHandler — turns one SQS message into a business outcome
 * through the shared ProcessWager, recording delivery accounting in the
 * Inbox. Returns the SQS action: ack (business result/duplicate), redeliver
 * (transient infra — let the visibility timeout retry), or redirect-dlq
 * (permanent failure — accelerate to the DLQ).
 *
 * Slice 7 does NOT modify ProcessWager; the financial effect is arbitrated
 * by `uq_wager_idempotency_key` exactly as the HTTP path does.
 */
@Injectable()
export class CommandMessageHandler {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: Promise<AppOrm>,
    private readonly inbox: InboxRepository,
    private readonly processWager: ProcessWager,
    private readonly metrics: MetricsService,
    @Inject('APP_ENV') private readonly env: AppEnv,
    private readonly logger: LoggerLike,
  ) {}

  async process(message: SqsMessage): Promise<HandleAction> {
    const messageId = message.MessageId ?? 'unknown';
    let parsed: WagerTransactionRequested;
    let bodyHash: string;
    try {
      parsed = parseMessageBody(message.Body ?? '');
      bodyHash = businessBodyHash(parsed);
    } catch {
      // Malformed / invalid payload → permanent; count toward DLQ but never
      // invoke ProcessWager.
      return this.permanent(messageId, payloadHash(message.Body ?? ''), null, 'INVALID_PAYLOAD');
    }
    const correlationId = parsed.correlationId ?? null;

    const orm = await this.orm;
    // Durable delivery accounting (received_count, body_hash).
    const { receivedCount, bodyHash: storedHash } = await orm.em.fork().transactional((em) =>
      this.inbox.upsert(em, CONSUMER_NAME, messageId, bodyHash, correlationId),
    );

    // Conflicting identity: same messageId but a different body.
    if (storedHash !== bodyHash) {
      return this.permanentFromCount(messageId, receivedCount, 'IDEMPOTENCY_CONFLICT');
    }

    // Already processed → identical redelivery → idempotent duplicate, ack.
    if (await this.inbox.isProcessed(CONSUMER_NAME, messageId)) {
      this.metrics.recordInboxReceived('duplicate');
      return 'ack';
    }

    // Not processed but received too many times → permanent DLQ redirect.
    if (receivedCount > this.env.CONSUMER_DLQ_MAX_RECEIVES) {
      return this.permanentFromCount(messageId, receivedCount, 'DLQ_MAX_RECEIVES');
    }

    const start = performance.now();
    try {
      const result = await this.processWager.execute(toSubmitWagerInput(parsed));
      const outcome = result.idempotentReplay
        ? 'duplicate'
        : result.status === 'REJECTED'
          ? 'rejected'
          : 'processed';
      await orm.em.fork().transactional((em) =>
        this.inbox.markProcessed(em, CONSUMER_NAME, messageId),
      );
      this.metrics.recordInboxReceived(outcome);
      this.logger.log({ messageId, outcome, transactionId: result.transactionId }, 'wager command processed');
      return 'ack';
    } catch (err) {
      if (isTransientError(err)) {
        this.metrics.recordInboxReceived('retried');
        this.logger.warn({ messageId }, 'transient failure — will be redelivered');
        return 'redeliver';
      }
      return this.permanentFromCount(messageId, receivedCount, errorCode(err) ?? 'PERMANENT');
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
    const { receivedCount } = await orm.em.fork().transactional((em) =>
      this.inbox.upsert(em, CONSUMER_NAME, messageId, bodyHash, correlationId),
    );
    return this.permanentFromCount(messageId, receivedCount, code);
  }

  private permanentFromCount(messageId: string, receivedCount: number, code: string): HandleAction {
    this.metrics.recordInboxReceived('dlq');
    if (receivedCount > this.env.CONSUMER_DLQ_MAX_RECEIVES) {
      this.metrics.recordConsumerDlq();
    }
    this.logger.warn({ messageId, code, receivedCount }, 'permanent failure — redirecting to DLQ');
    return 'redirect-dlq';
  }
}

export function parseMessageBody(raw: string): WagerTransactionRequested {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new UnprocessableEntityException({ code: 'INVALID_PAYLOAD' });
  }
  const b = body as Record<string, unknown>;
  const required: (keyof WagerTransactionRequested)[] = [
    'kind', 'idempotencyKey', 'providerId', 'externalTransactionId',
    'playerId', 'walletId', 'roundId', 'gameId', 'money',
  ];
  for (const key of required) {
    if (b[key] === undefined || b[key] === null) {
      throw new UnprocessableEntityException({ code: 'INVALID_PAYLOAD' });
    }
  }
  const money = b.money as Record<string, unknown>;
  if (typeof money.amount !== 'string' || typeof money.currency !== 'string') {
    throw new UnprocessableEntityException({ code: 'INVALID_PAYLOAD' });
  }
  return {
    kind: b.kind as WagerKind,
    idempotencyKey: b.idempotencyKey as string,
    providerId: b.providerId as string,
    externalTransactionId: b.externalTransactionId as string,
    playerId: b.playerId as string,
    walletId: b.walletId as string,
    roundId: b.roundId as string,
    gameId: b.gameId as string,
    money: { amount: money.amount, currency: money.currency },
    ...(b.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: b.referenceExternalTransactionId as string }
      : {}),
    ...(b.correlationId !== undefined ? { correlationId: b.correlationId as string } : {}),
  };
}

/** Business-field body hash — same scheme as wagerPayloadHash. */
export function businessBodyHash(body: WagerTransactionRequested): string {
  return wagerPayloadHash({
    kind: body.kind,
    playerId: body.playerId,
    walletId: body.walletId,
    roundId: body.roundId,
    gameId: body.gameId,
    externalTransactionId: body.externalTransactionId,
    providerId: body.providerId,
    money: body.money,
    ...(body.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: body.referenceExternalTransactionId }
      : {}),
  });
}

function toSubmitWagerInput(body: WagerTransactionRequested): SubmitWagerInput {
  return {
    idempotencyKey: body.idempotencyKey,
    providerId: body.providerId,
    externalTransactionId: body.externalTransactionId,
    playerId: body.playerId,
    walletId: body.walletId,
    roundId: body.roundId,
    gameId: body.gameId,
    kind: body.kind,
    money: body.money,
    ...(body.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: body.referenceExternalTransactionId }
      : {}),
    ...(body.correlationId !== undefined ? { correlationId: body.correlationId } : {}),
  };
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
