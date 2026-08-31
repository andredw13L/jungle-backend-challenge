import { z } from 'zod';
import { Money } from '../../domain/money';
import type { SubmitWagerInput } from '../process-wager.types';

const DecimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/);
export const IdempotencyKeySchema = z.string().min(1).max(256);
const Identifier = IdempotencyKeySchema;

const WagerBusinessObject = z.object({
  providerId: Identifier,
  externalTransactionId: Identifier,
  playerId: z.string().uuid(),
  walletId: z.string().uuid(),
  roundId: Identifier,
  gameId: Identifier,
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: z
    .object({
      amount: DecimalString,
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .strict(),
  referenceExternalTransactionId: Identifier.optional(),
}).strict();

function referenceRules(
  value: { kind: string; referenceExternalTransactionId?: string | undefined },
  ctx: z.RefinementCtx,
): void {
    if ((value.kind === 'BET' || value.kind === 'LOSS') && value.referenceExternalTransactionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['referenceExternalTransactionId'],
        message: `${value.kind} does not accept a referenceExternalTransactionId`,
      });
    }
    if ((value.kind === 'REFUND' || value.kind === 'ROLLBACK') && !value.referenceExternalTransactionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['referenceExternalTransactionId'],
        message: 'REFUND and ROLLBACK require a referenceExternalTransactionId',
      });
    }
}

/** The only shape accepted by the public wagering endpoint. */
export const SubmitWagerSchema = WagerBusinessObject.superRefine(referenceRules);

/** The business data shape carried by the official SQS envelope. */
export const SqsWagerDataSchema = WagerBusinessObject
  .extend({ idempotencyKey: Identifier })
  .strict()
  .superRefine(referenceRules);

export type SubmitWagerDto = z.infer<typeof SubmitWagerSchema>;
export type SqsWagerDataDto = z.infer<typeof SqsWagerDataSchema>;

/** Normalize the validated HTTP business payload at the shared boundary. */
export function normalizeHttpWager(
  dto: SubmitWagerDto,
  idempotencyKey: string,
  correlationId?: string,
): SubmitWagerInput {
  return normalizeWager(dto, idempotencyKey, correlationId);
}

/** Normalize the validated SQS business payload using the same rules as HTTP. */
export function normalizeSqsWager(dto: SqsWagerDataDto, correlationId?: string): SubmitWagerInput {
  return normalizeWager(dto, dto.idempotencyKey, correlationId);
}

function normalizeWager(
  dto: SubmitWagerDto | SqsWagerDataDto,
  idempotencyKey: string,
  correlationId?: string,
): SubmitWagerInput {
  return {
    idempotencyKey,
    providerId: dto.providerId,
    externalTransactionId: dto.externalTransactionId,
    playerId: dto.playerId,
    walletId: dto.walletId,
    roundId: dto.roundId,
    gameId: dto.gameId,
    kind: dto.kind,
    money: Money.create(dto.money).toJSON(),
    ...(dto.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: dto.referenceExternalTransactionId }
      : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
}
