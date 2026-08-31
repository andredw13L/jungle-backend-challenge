import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../../src/config/env';

const env = loadEnv();
const up = readFileSync(new URL('../../migrations/004_inbox.sql', import.meta.url), 'utf8');
const down = readFileSync(new URL('../../migrations/004_inbox.down.sql', import.meta.url), 'utf8');

describe('migration 004 inbox round-trip', () => {
  test('evolves 001, reverses, and evolves again without losing rows', async () => {
    const client = new Client({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 5000,
    });
    const schema = `migration_004_${crypto.randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE inbox (
          consumer_name text NOT NULL,
          message_id text NOT NULL,
          payload jsonb NOT NULL,
          received_at timestamptz NOT NULL DEFAULT now(),
          processed_at timestamptz,
          PRIMARY KEY (consumer_name, message_id)
        )
      `);
      await client.query(
        `INSERT INTO inbox (consumer_name, message_id, payload) VALUES ($1, $2, $3)`,
        ['consumer', 'message', JSON.stringify({ safe: true })],
      );

      await client.query(up);
      const evolved = await client.query<{
        payload: { safe: boolean };
        body_hash: string;
        received_count: number;
        first_received_at: Date;
        last_received_at: Date;
      }>(`SELECT payload, body_hash, received_count, first_received_at, last_received_at FROM inbox`);
      expect(evolved.rows[0]).toMatchObject({
        payload: { safe: true },
        received_count: 1,
      });
      expect(evolved.rows[0]?.body_hash).toBeTruthy();
      expect(evolved.rows[0]?.first_received_at).toBeTruthy();
      expect(evolved.rows[0]?.last_received_at).toBeTruthy();

      await client.query(down);
      const reverted = await client.query<{ payload: { safe: boolean } }>(`SELECT payload FROM inbox`);
      expect(reverted.rows[0]?.payload).toEqual({ safe: true });

      await client.query(up);
      const evolvedAgain = await client.query<{
        payload: { safe: boolean };
        body_hash: string;
        received_count: number;
      }>(`SELECT payload, body_hash, received_count FROM inbox`);
      expect(evolvedAgain.rows[0]).toMatchObject({
        payload: { safe: true },
        received_count: 1,
      });
      expect(evolvedAgain.rows[0]?.body_hash).toBeTruthy();
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }, 15000);
});
