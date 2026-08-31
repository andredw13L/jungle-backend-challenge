import { z } from 'zod';

const DecimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/, {
  message: 'amount must be a decimal string with at most 2 fractional digits',
});

export const CreateWalletSchema = z
  .object({
    playerId: z.string().uuid(),
    initialBalance: z
      .object({
        amount: DecimalString,
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
  })
  .strict();

export type CreateWalletDto = z.infer<typeof CreateWalletSchema>;
