import { afterAll, describe, expect, test } from 'bun:test';
import { loadEnv, makeEnv } from '../../src/config/env';
import { WalletEntity } from '../../src/infrastructure/database/entities';
import { createOrm } from '../../src/infrastructure/database/orm.module';

const env = loadEnv();

describe('MikroORM foundation', () => {
  test('initializes without connecting and exposes exactly the canonical tables', async () => {
    const orm = await createOrm(
      makeEnv({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/unreachable' }),
    );

    expect(await orm.isConnected()).toBe(false);
    expect(
      [...orm.getMetadata().getAll().values()]
        .map((metadata) => metadata.tableName)
        .sort(),
    ).toEqual([
      'inbox',
      'outbox',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);

    await orm.close(true);
  });

  describe('real PostgreSQL round-trip', () => {
    let orm: Awaited<ReturnType<typeof createOrm>>;
    const walletIds: string[] = [];

    afterAll(async () => {
      if (!orm) return;
      const em = orm.em.fork();
      for (const id of walletIds) {
        await em.nativeDelete(WalletEntity, { id });
      }
      await orm.close(true);
    });

    test('keeps NUMERIC(18,2) values as exact strings after clear and reload', async () => {
      orm = await createOrm(env);
      await orm.connect();

      const em = orm.em.fork();
      const now = new Date();
      const first = em.create(WalletEntity, {
        id: crypto.randomUUID(),
        playerId: `mikro-orm-010-${crypto.randomUUID()}`,
        currency: 'BRL',
        balanceAmount: '0.10',
        balanceCurrency: 'BRL',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const second = em.create(WalletEntity, {
        id: crypto.randomUUID(),
        playerId: `mikro-orm-2500-${crypto.randomUUID()}`,
        currency: 'BRL',
        balanceAmount: '25.00',
        balanceCurrency: 'BRL',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      walletIds.push(first.id, second.id);
      em.persist([first, second]);
      await em.flush();
      em.clear();

      const loadedFirst = await em.findOneOrFail(WalletEntity, { id: first.id });
      const loadedSecond = await em.findOneOrFail(WalletEntity, { id: second.id });
      expect(loadedFirst.balanceAmount).toBe('0.10');
      expect(typeof loadedFirst.balanceAmount).toBe('string');
      expect(loadedSecond.balanceAmount).toBe('25.00');
      expect(typeof loadedSecond.balanceAmount).toBe('string');
    });
  });
});
