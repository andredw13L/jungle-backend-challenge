/**
 * Migration runner — applies pending .sql files in order, tracking state in
 * the `_migrations` table. Idempotent; safe to re-run.
 *
 *   bun run scripts/migrate.ts up      # apply pending
 *   bun run scripts/migrate.ts down    # reverse the last applied
 *   bun run scripts/migrate.ts status  # show applied vs available
 */
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';
import { loadEnv } from '../src/config/env';

const MIGRATIONS_DIR = './migrations';

async function ensureMigrationTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function applied(client: Client): Promise<Set<string>> {
  const r = await client.query<{ id: string }>(`SELECT id FROM _migrations ORDER BY id`);
  return new Set(r.rows.map((row) => row.id));
}

function listMigrations(): { up: string[]; down: Map<string, string> } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  const down = new Map<string, string>();
  for (const f of files) {
    const downFile = f.replace(/\.sql$/, '.down.sql');
    down.set(f, downFile);
  }
  return { up: files, down };
}

async function runUp(client: Client): Promise<void> {
  await ensureMigrationTable(client);
  const done = await applied(client);
  const { up } = listMigrations();
  for (const id of up) {
    if (done.has(id)) continue;
    const sql = readFileSync(`${MIGRATIONS_DIR}/${id}`, 'utf8');
    console.log(`+ applying ${id}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(`INSERT INTO _migrations (id) VALUES ($1)`, [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
}

async function runDown(client: Client): Promise<void> {
  await ensureMigrationTable(client);
  const done = await applied(client);
  const last = [...done].sort().pop();
  if (!last) {
    console.log('no migrations to revert');
    return;
  }
  const downFile = `${MIGRATIONS_DIR}/${last.replace(/\.sql$/, '.down.sql')}`;
  const sql = readFileSync(downFile, 'utf8');
  console.log(`- reverting ${last}`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(`DELETE FROM _migrations WHERE id = $1`, [last]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function runStatus(client: Client): Promise<void> {
  await ensureMigrationTable(client);
  const done = await applied(client);
  const { up } = listMigrations();
  for (const id of up) {
    console.log(`${done.has(id) ? '✓' : '✗'} ${id}`);
  }
}

const cmd = process.argv[2] ?? 'up';
const env = loadEnv();
const client = new Client({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
});
await client.connect();
try {
  if (cmd === 'up') await runUp(client);
  else if (cmd === 'down') await runDown(client);
  else if (cmd === 'status') await runStatus(client);
  else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
} finally {
  await client.end().catch(() => undefined);
}