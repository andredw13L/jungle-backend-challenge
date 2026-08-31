import { z } from 'zod';

const DecimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d{2})$/, {
  message: 'amount must be a decimal string with exactly 2 fractional digits',
});

export const CreateWalletSchema = z
  .object({
    playerId: z.string().min(1).max(256),
    currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code'),
    initialBalance: z.object({
      amount: DecimalString,
      currency: z.string().regex(/^[A-Z]{3}$/),
    }),
  })
  .refine((v) => v.initialBalance.currency === v.currency, {
    message: 'initialBalance.currency must match wallet currency',
    path: ['initialBalance', 'currency'],
  });

export type CreateWalletDto = z.infer<typeof CreateWalletSchema>;