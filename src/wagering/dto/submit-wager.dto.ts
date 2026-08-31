import { z } from 'zod';

const DecimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/);
const Identifier = z.string().min(1).max(256);

/** The only shape accepted by the public wagering endpoint. */
export const SubmitWagerSchema = z
  .object({
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
  })
  .strict()
  .superRefine((value, ctx) => {
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
  });

export type SubmitWagerDto = z.infer<typeof SubmitWagerSchema>;
