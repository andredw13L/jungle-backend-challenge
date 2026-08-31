import { Inject } from '@nestjs/common';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { MIKRO_ORM } from '../infrastructure/database/entities';
import type { AppOrm } from '../infrastructure/database/orm.module';

/** Stable identity of the command consumer, part of the inbox PK. */
export const CONSUMER_NAME = 'wager-command-consumer';

export interface InboxClaim {
  receivedCount: number;
  bodyHash: string;
  processed: boolean;
}

/**
 * InboxRepository — raw SQL over the `inbox` table (slice 7). Each delivery
 * is recorded with `received_count`/`body_hash` so the consumer can dedupe
 * identical redeliveries, detect conflicting bodies, and drive DLQ
 * classification. All writes are issued inside the caller's transaction.
 */
export class InboxRepository {
  constructor(@Inject(MIKRO_ORM) private readonly orm: Promise<AppOrm>) {}

  /**
   * Insert-or-bump a delivery. On a fresh message returns the inserted
   * body_hash; on a conflict returns the *stored* body_hash (unchanged) and
   * an incremented received_count. The caller compares the returned hash
   * against the current message's hash to detect IDEMPOTENCY_CONFLICT.
   */
  async upsert(
    em: PostgreSqlEntityManager,
    consumerName: string,
    messageId: string,
    bodyHash: string,
    correlationId: string | null,
  ): Promise<InboxClaim> {
    const r = await em.execute<{ received_count: number; body_hash: string; processed_at: Date | null }[]>(
      `INSERT INTO inbox
         (consumer_name, message_id, body_hash, received_count, first_received_at, last_received_at, correlation_id)
       VALUES (?, ?, ?, 1, now(), now(), ?)
       ON CONFLICT (consumer_name, message_id) DO UPDATE SET
         received_count = inbox.received_count + 1,
         last_received_at = now()
       RETURNING received_count, body_hash, processed_at`,
      [consumerName, messageId, bodyHash, correlationId],
    );
    return {
      receivedCount: r[0]!.received_count,
      bodyHash: r[0]!.body_hash,
      processed: r[0]!.processed_at !== null,
    };
  }

  /** Marks a delivery as successfully processed (idempotent). */
  async markProcessed(
    em: PostgreSqlEntityManager,
    consumerName: string,
    messageId: string,
  ): Promise<void> {
    await em.execute(
      `UPDATE inbox SET processed_at = now()
       WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
  }

  async isProcessed(consumerName: string, messageId: string): Promise<boolean> {
    const r = await (await this.orm).em.fork().execute<{ processed_at: Date | null }[]>(
      `SELECT processed_at FROM inbox
       WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
    return r[0]?.processed_at != null;
  }
}
