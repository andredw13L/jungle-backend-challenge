import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const up = readFileSync(new URL('../../migrations/004_inbox.sql', import.meta.url), 'utf8');
const down = readFileSync(new URL('../../migrations/004_inbox.down.sql', import.meta.url), 'utf8');

describe('migration 004 inbox round-trip', () => {
  test('up evolves the 001 inbox and down reverses that shape', () => {
    expect(up).toMatch(/ALTER TABLE\s+inbox/i);
    expect(up).not.toMatch(/DROP TABLE/i);
    expect(up).not.toMatch(/DROP COLUMN\s+(payload|received_at)/i);
    expect(down).toMatch(/ALTER TABLE\s+inbox/i);
    expect(down).not.toMatch(/CREATE TABLE\s+inbox/i);
  });
});
