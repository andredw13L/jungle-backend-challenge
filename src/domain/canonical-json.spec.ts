import { describe, expect, test } from 'bun:test';
import { canonicalize, payloadHash } from './canonical-json';

describe('canonicalize', () => {
  test('sorts object keys at every depth', () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } });
    expect(a).toBe('{"a":{"x":1,"y":2},"b":1}');
  });

  test('preserves array order', () => {
    expect(canonicalize({ arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}');
  });

  test('is stable under property reordering', () => {
    const payload = { type: 'BET', amount: '10.00', currency: 'BRL' };
    const reordered = { currency: 'BRL', amount: '10.00', type: 'BET' };
    expect(canonicalize(payload)).toBe(canonicalize(reordered));
  });

  test('handles null and primitives', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize(true)).toBe('true');
  });
});

describe('payloadHash', () => {
  test('produces stable SHA-256 hex regardless of property order', () => {
    const a = payloadHash({ type: 'BET', amount: '10.00', currency: 'BRL' });
    const b = payloadHash({ currency: 'BRL', amount: '10.00', type: 'BET' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different payloads produce different hashes', () => {
    expect(payloadHash({ amount: '10.00' })).not.toBe(payloadHash({ amount: '10.01' }));
  });
});