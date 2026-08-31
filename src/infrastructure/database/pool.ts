import { Pool } from 'pg';
import type { AppEnv } from '../../config/env';

/**
 * Single PostgreSQL connection pool per process. The slice 9 harness
 * boots three processes, each with its own pool; correctness does not
 * depend on pool topology — the schema's named constraints arbitrate
 * races regardless of how many pools touch the database.
 *
 * `pg` returns NUMERIC columns as strings by default, so money never
 * touches `number` on the wire.
 */
export function makePool(env: AppEnv): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    max: 10,
  });
}

export const POOL = Symbol('PG_POOL');