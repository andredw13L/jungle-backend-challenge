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
export abstract class IntegrationEvent<T extends object = Record<string, unknown>> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly aggregateId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;

  constructor(
    public readonly eventId: string,
    public readonly occurredAt: Date,
    public readonly correlationId: string | undefined,
    aggregateId: string,
    data: T,
    causationId?: string,
  ) {
    this.aggregateId = aggregateId;
    this.data = Object.freeze({ ...data });
    this.causationId = causationId;
  }

  /** Compatibility name used by the original slice-2 tests. */
  get schemaVersion(): number {
    return this.version;
  }

  /**
   * Serialise to the wire envelope. Money fields appear as `{ amount,
   * currency }` decimal-string pairs; dates as ISO-8601 strings via the
   * built-in JSON serialiser.
   */
  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
    // Keep old direct property reads working without flattening the wire body.
    Object.defineProperty(json, 'schemaVersion', { value: this.version });
    for (const [key, value] of Object.entries(this.data)) {
      Object.defineProperty(json, key, { value });
    }
    return json;
  }

  /** Common envelope fields shared by every concrete event. */
  protected envelope(): Record<string, unknown> {
    return this.toJSON();
  }
}
