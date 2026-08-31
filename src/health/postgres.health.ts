import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, type HealthIndicatorResult } from '@nestjs/terminus';
import { Client } from 'pg';
import type { AppEnv } from '../config/env';

/**
 * PostgreSQL readiness indicator. Opens a fresh connection and runs the
 * cheapest possible round-trip (`SELECT 1`). Slice 3 will swap this for a
 * dedicated pool when migrations land; for slice 1 the cheap probe is enough.
 */
@Injectable()
export class PostgresHealthIndicator {
  constructor(@Inject('APP_ENV') private readonly env: AppEnv) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const client = new Client({
      connectionString: this.env.DATABASE_URL,
      ssl: this.env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 2000,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return { [key]: { status: 'up' } };
    } catch (err) {
      // ponytail: do not echo connection-string fragments in /health output;
      // the pg library can fold DSN pieces into ECONNREFUSED messages.
      const message = err instanceof Error ? err.message : String(err);
      const safe = message.replace(this.env.DATABASE_URL, '<db-url>');
      throw new HealthCheckError('PostgreSQL not ready', {
        [key]: { status: 'down', error: safe },
      });
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}