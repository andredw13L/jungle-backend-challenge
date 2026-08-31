/**
 * Ledger cursor — opaque Base64URL encoding of `{createdAt, id}`. The
 * pair uniquely orders entries within a wallet because
 * `idx_ledger_wallet_created (wallet_id, created_at DESC, id DESC)`
 * already exists in the schema. Stable under inserts because PostgreSQL
 * assigns `created_at = now()` at insert time.
 */
export interface LedgerCursor {
  createdAt: string;
  id: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(raw: string): LedgerCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as LedgerCursor).createdAt !== 'string' ||
      typeof (parsed as LedgerCursor).id !== 'string' ||
      !UUID_REGEX.test((parsed as LedgerCursor).id) ||
      isNaN(Date.parse((parsed as LedgerCursor).createdAt))
    ) {
      return null;
    }
    return parsed as LedgerCursor;
  } catch {
    return null;
  }
}