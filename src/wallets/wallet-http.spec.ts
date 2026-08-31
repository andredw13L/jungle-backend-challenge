import { describe, expect, test } from 'bun:test';
import { UnprocessableEntityException } from '@nestjs/common';
import { Money } from '../domain/money';
import { WalletCreationService } from './wallet-creation.service';
import { WalletsController } from './wallets.controller';
import { CreateWalletSchema } from './dto/create-wallet.dto';

const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

function walletRow() {
  return {
    id: '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId,
    currency: 'BRL',
    balanceAmount: '25.00',
    balanceCurrency: 'BRL',
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('POST /wallets contract', () => {
  test('accepts only a UUID playerId and nested initialBalance, normalizing amounts through Money', async () => {
    const body = {
      playerId,
      initialBalance: { amount: '25', currency: 'BRL' },
    };
    const parsed = CreateWalletSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(body);

    let captured: { amount: string; currency: string } | undefined;
    const service = new WalletCreationService({
      createAtomic: async (input: { initialBalance: { amount: string; currency: string } }) => {
        captured = input.initialBalance;
        return { wallet: walletRow() };
      },
    } as never);

    for (const amount of ['25', '25.0', '25.00']) {
      const amountParsed = CreateWalletSchema.safeParse({
        ...body,
        initialBalance: { amount, currency: 'BRL' },
      });
      expect(amountParsed.success).toBe(true);
      if (!amountParsed.success) return;
      await service.create(amountParsed.data);
      expect(captured).toEqual(Money.create({ amount, currency: 'BRL' }).toJSON());
      expect(captured?.amount).toBe('25.00');
    }
  });

  test('rejects top-level currency and unknown nested keys', () => {
    const base = {
      playerId,
      initialBalance: { amount: '25.00', currency: 'BRL' },
    };
    expect(CreateWalletSchema.safeParse({ ...base, currency: 'BRL' }).success).toBe(false);
    expect(
      CreateWalletSchema.safeParse({
        ...base,
        initialBalance: { ...base.initialBalance, extra: true },
      }).success,
    ).toBe(false);
  });

  test('throws HTTP 422 for malformed payload instead of returning a 201 body', async () => {
    const controller = new WalletsController({} as never, {} as never);
    await expect(
      controller.create({
        playerId: 'not-a-uuid',
        initialBalance: { amount: '25.000', currency: 'BRL' },
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
