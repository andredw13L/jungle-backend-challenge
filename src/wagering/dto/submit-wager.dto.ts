import { z } from 'zod';

const DecimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d{2})$/);

export const SubmitWagerSchema = z
  .object({
    type: z.enum(['BET', 'WIN', 'LOSS']),
    playerId: z.string().min(1).max(256),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: z.object({
      amount: DecimalString,
      currency: z.string().regex(/^[A-Z]{3}$/),
    }),
    externalTransactionId: z.string().min(1).max(256),
    providerId: z.string().min(1).max(256),
  })
  .strict()
  .refine((v) => v.amount.currency === v.currency, {
    message: 'amount.currency must match wallet currency',
    path: ['amount', 'currency'],
  });

export type SubmitWagerDto = z.infer<typeof SubmitWagerSchema>;