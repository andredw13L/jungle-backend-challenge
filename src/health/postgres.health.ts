import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, type HealthIndicatorResult } from '@nestjs/terminus';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MIKRO_ORM } from '../infrastructure/database/entities';

/**
 * PostgreSQL readiness indicator. Uses a fork of the process-wide ORM so the
 * readiness probe shares the same connection configuration as application work.
 */
@Injectable()
export class PostgresHealthIndicator {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const em = this.orm.em.fork();
    try {
      await em.getConnection().execute('SELECT 1');
      return { [key]: { status: 'up' } };
    } catch {
      throw new HealthCheckError('PostgreSQL not ready', {
        [key]: { status: 'down' },
      });
    }
  }
}
