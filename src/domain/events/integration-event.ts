/**
 * IntegrationEvent envelope. Every event published by the service carries:
 *
 * - `eventId`: stable identifier (uuidv7 in slice 8) used for Outbox dedup
 *   and consumer idempotency.
 * - `occurredAt`: ISO-8601 timestamp serialised via `Date#toJSON`.
 * - `correlationId`: optional caller-supplied header for tracing.
 * - `eventType`: a literal discriminant so consumers can dispatch by name.
 * - `schemaVersion`: per-type schema revision; consumers reject older
 *   versions explicitly.
 *
 * Concrete subclasses MUST keep `eventType` and `schemaVersion` readonly so
 * the envelope stays immutable after construction.
 */
export abstract class IntegrationEvent {
  abstract readonly eventType: string;
  abstract readonly schemaVersion: number;

  constructor(
    public readonly eventId: string,
    public readonly occurredAt: Date,
    public readonly correlationId: string | undefined,
  ) {}

  /**
   * Serialise to the wire envelope. Money fields appear as `{ amount,
   * currency }` decimal-string pairs; dates as ISO-8601 strings via the
   * built-in JSON serialiser.
   */
  abstract toJSON(): Record<string, unknown>;

  /** Common envelope fields shared by every concrete event. */
  protected envelope(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      schemaVersion: this.schemaVersion,
      occurredAt: this.occurredAt.toISOString(),
      correlationId: this.correlationId,
    };
  }
}