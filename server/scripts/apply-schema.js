#!/usr/bin/env node
/**
 * Apply the authoritative schema (server/SCHEMA.sql) to a Postgres database.
 *
 * R-1 in SECURITY_REPORT.md: SCHEMA.sql defines apply_movement(), the RLS
 * policies, the non-negative-balance CHECKs and the append-only ledger trigger,
 * but it had never been executed against a live database in that environment.
 * This script is the executable form of the "apply then re-verify" step.
 *
 * USAGE
 *   cd server
 *   SUPABASE_DB_URL="postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
 *     npm run db:apply
 *
 * Get SUPABASE_DB_URL from Supabase: Project Settings -> Database -> Connection
 * string (URI). This is a DIRECT Postgres connection and is distinct from
 * SUPABASE_URL / the anon key; it is used only by this migration script (the
 * running server still talks to PostgREST with the service-role key).
 *
 * Requires the `pg` package. If it is not installed, run:
 *   npm install pg
 *
 * SAFETY
 *   - Runs inside a single transaction: any failed statement rolls the whole
 *     thing back, so a partial schema is never left behind.
 *   - SCHEMA.sql is written to be idempotent (IF NOT EXISTS / DO-block guarded),
 *     so re-running it against a live database is safe and non-destructive.
 */

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, '..', 'SCHEMA.sql');

function fail(message) {
  console.error(`\n[db:apply] ${message}\n`);
  process.exit(1);
}

function loadPg() {
  try {
    // eslint-disable-next-line global-require
    return require('pg');
  } catch (error) {
    fail(
      'The "pg" package is not installed. Install it and retry:\n' +
        '  npm install pg\n\n' +
        'Alternatively apply the schema with psql directly:\n' +
        '  psql "$SUPABASE_DB_URL" -f server/SCHEMA.sql'
    );
  }
}

async function main() {
  const connectionString =
    process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';

  if (!connectionString) {
    fail(
      'No database connection string. Set SUPABASE_DB_URL (preferred) or DATABASE_URL:\n' +
        '  SUPABASE_DB_URL="postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" npm run db:apply'
    );
  }

  if (!fs.existsSync(SCHEMA_PATH)) fail(`SCHEMA.sql not found at ${SCHEMA_PATH}`);

  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const { Client } = loadPg();

  // Supabase requires TLS. rejectUnauthorized:false tolerates its managed cert
  // chain in environments without the CA bundle preloaded; the connection is
  // still encrypted. Set PGSSLMODE=verify-full if you have the CA.
  const ssl =
    process.env.PGSSLMODE === 'disable'
      ? false
      : { rejectUnauthorized: process.env.PGSSLMODE === 'verify-full' };

  const client = new Client({ connectionString, ssl });

  client.on('notice', (msg) => {
    if (msg && msg.message) console.log(`   notice: ${msg.message}`);
  });

  console.log('[db:apply] Connecting...');
  await client.connect();
  console.log('[db:apply] Connected. Applying SCHEMA.sql (single transaction)...');

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    fail(`Schema application failed and was rolled back:\n         ${error.message}`);
  } finally {
    await client.end().catch(() => {});
  }

  console.log('[db:apply] ✅ Schema applied.');
  console.log('[db:apply] Next: set USE_SUPABASE=true and SUPABASE_SERVICE_ROLE_KEY, then start the server.');
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
