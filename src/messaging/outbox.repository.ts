import { Inject } from '@nestjs/common';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { MIKRO_ORM } from '../infrastructure/database/entities';
import type { AppOrm } from '../infrastructure/database/orm.module';

export interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  schema_version: number;
  /** The envelope payload serialised as text (payload::text). */
  payload: string;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  attempts: number;
  next_attempt_at: Date | string;
  last_error: string | null;
  created_at: Date | string;
}

/**
 * OutboxRepository — raw SQL over the `outbox` table (slice 8). The claim is
 * the unit of parallelism: one due PENDING row per transaction with
 * `FOR UPDATE SKIP LOCKED`, so concurrent publisher instances divide work
 * without coordination. `markPublished`/`markFailed` are always issued
 * against a row the caller has just claimed.
 */
export class OutboxRepository {
  constructor(@Inject(MIKRO_ORM) private readonly orm: Promise<AppOrm>) {}

  /**
   * Claim the single oldest due row. Runs inside the caller's transaction;
   * the row stays locked until that transaction commits or rolls back.
   * Returns null when nothing is due or every due row is locked elsewhere.
   */
  async claimDue(em: PostgreSqlEntityManager): Promise<OutboxRow | null> {
    const r = await em.execute<OutboxRow[]>(
      `SELECT id, event_id, event_type, schema_version,
              payload::text AS payload, status, attempts,
              next_attempt_at, last_error, created_at
       FROM outbox
       WHERE status = 'PENDING' AND next_attempt_at <= now()
       ORDER BY next_attempt_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    return r[0] ?? null;
  }

  /** Mark the claimed row published after the broker accepted the event. */
  async markPublished(em: PostgreSqlEntityManager, id: string): Promise<void> {
    await em.execute(
      `UPDATE outbox
       SET status = 'PUBLISHED', published_at = now(), attempts = attempts + 1
       WHERE id = ?`,
      [id],
    );
  }

  /**
   * Schedule a retry for a failed send. `delaySeconds` is applied from now;
   * the row stays PENDING. `last_error` is truncated to a bounded size so a
   * pathological broker message cannot bloat the table.
   */
  async markFailed(
    em: PostgreSqlEntityManager,
    id: string,
    delaySeconds: number,
    error: string,
  ): Promise<void> {
    await em.execute(
      `UPDATE outbox
       SET attempts = attempts + 1,
           next_attempt_at = now() + (? * interval '1 second'),
           last_error = ?
       WHERE id = ?`,
      [delaySeconds, error.slice(0, 2000), id],
    );
  }

  /** Number of rows the publisher can claim right now (PENDING and due). */
  async countDue(): Promise<number> {
    const r = await (await this.orm).em.fork().execute<{ c: number }[]>(
      `SELECT count(*)::int AS c
       FROM outbox
       WHERE status = 'PENDING' AND next_attempt_at <= now()`,
    );
    return r[0]!.c;
  }

  /**
   * Age of the oldest PENDING event in seconds (0 when the outbox is empty).
   * Feeds the `outbox_lag_seconds` gauge — exposes the age, never the payload.
   */
  async lagSeconds(): Promise<number> {
    const r = await (await this.orm).em.fork().execute<{ lag: number | null }[]>(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))), 0)::double precision AS lag
       FROM outbox
       WHERE status = 'PENDING'`,
    );
    return Number(r[0]?.lag ?? 0);
  }
}