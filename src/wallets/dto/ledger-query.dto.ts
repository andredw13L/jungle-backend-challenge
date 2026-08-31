import { z } from 'zod';

export const LedgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;