import { createHash } from 'node:crypto';

/**
 * Canonical JSON serializer — JCS-aligned for our domain shapes.
 *
 * The OpenSpec wager-processing spec requires canonical JSON per RFC 8785
 * for payload hashing. We only serialise flat-ish business objects
 * (strings, numbers as strings, ISO dates, nested `{amount, currency}`
 * pairs), so a minimal recursive key-sort + deterministic value
 * serialiser satisfies the spec — the full RFC 8785 numeric/escape
 * edge cases do not apply.
 *
 * Rules applied:
 * - Object keys sorted lexicographically at every depth.
 * - Arrays preserve order (they are positional, not keyed).
 * - Strings, numbers, booleans, null serialised via JSON.stringify on
 *   the already-resorted tree.
 * - No whitespace.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

function toCanonical(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(toCanonical);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = toCanonical(obj[key]);
    }
    return result;
  }
  return value;
}

/**
 * SHA-256 of the canonical JSON, returned as lowercase hex.
 */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}