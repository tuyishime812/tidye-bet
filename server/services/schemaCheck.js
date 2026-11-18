/**
 * Boot-time schema verification (R-1 in SECURITY_REPORT.md).
 *
 * WHY THIS EXISTS
 * ---------------
 * SCHEMA.sql is the authoritative definition of the money model: the
 * `apply_movement` RPC, the RLS policies, the non-negative-balance CHECKs and
 * the append-only ledger trigger. The application MIRRORS those invariants in
 * services/ledger.js, but a mirror is not the real thing.
 *
 * Previously a missing or stale schema surfaced only at the first write, as an
 * opaque PostgREST error mid-deposit - or, worse, the ledger RPC would be
 * missing and the only working money path would be an unsafe read-then-write.
 * This module lets the server PROVE, before it accepts a single bet, that the
 * schema it depends on is actually installed.
 *
 * The `apply_movement` probe is deliberately harmless: it is called with
 * delta = 0 / hold = 0, which the function rejects with 'invalid request'
 * BEFORE acquiring a row lock or writing anything. So a successful probe proves
 * the function exists and is callable without touching any balance.
 */

/** Tables the application requires. A missing one is a fatal misconfiguration. */
const REQUIRED_TABLES = [
  'users',
  'balance_ledger',
  'deposits',
  'withdrawals',
  'audit_logs',
  'admins'
];

/** PostgREST / Postgres error codes that mean "the object does not exist". */
const MISSING_OBJECT_RE =
  /PGRST202|PGRST205|42883|42P01|does not exist|schema cache|not find the (function|table)/i;

/** A well-formed but non-existent UUID, used only to probe the RPC. */
const PROBE_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Confirm every required table is queryable.
 * @returns {Promise<{ok:boolean, missing:string[], error?:string}>}
 */
async function checkTables(supabase) {
  const missing = [];
  for (const table of REQUIRED_TABLES) {
    const { error } = await supabase.from(table).select('id').limit(0);
    if (error) {
      if (MISSING_OBJECT_RE.test(`${error.code || ''} ${error.message || ''}`)) {
        missing.push(table);
      } else {
        // A permission/network error is not "missing": report it distinctly so
        // the operator is not told to re-apply the schema when the real problem
        // is connectivity or the wrong key.
        return { ok: false, missing, error: `${table}: ${error.message}` };
      }
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Confirm the atomic ledger RPC exists and is callable.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function checkLedgerRpc(supabase) {
  const { error } = await supabase.rpc('apply_movement', {
    p_user_id: PROBE_UUID,
    p_balance_delta: 0,
    p_hold_delta: 0,
    p_reason: 'DEPOSIT'
  });

  if (!error) {
    // The function ran and returned its "invalid request" row: it exists.
    return { ok: true };
  }
  if (MISSING_OBJECT_RE.test(`${error.code || ''} ${error.message || ''}`)) {
    return { ok: false, error: 'apply_movement() is missing' };
  }
  return { ok: false, error: `apply_movement(): ${error.message}` };
}

/**
 * Full schema verification.
 * @param {object} supabase  a configured service-role Supabase client
 * @returns {Promise<{ok:boolean, missing:string[], problems:string[]}>}
 */
async function verifySchema(supabase) {
  const problems = [];

  const { data: authData, error: authError } = await supabase
    .from('users')
    .select('id, balance, held')
    .limit(1);
  if (authError && MISSING_OBJECT_RE.test(`${authError.code || ''} ${authError.message || ''}`)) {
    // users is missing entirely; the per-table loop below will detail it.
    problems.push('users table is not reachable');
  } else if (!authError && authData && authData[0]) {
    // Extra guard: a schema that predates the escrow model has no `held`
    // column, and every withdrawal would fail at runtime. Detect it now.
    if (!Object.prototype.hasOwnProperty.call(authData[0], 'held')) {
      problems.push('users.held column is missing (schema predates the escrow model)');
    }
  }

  const tables = await checkTables(supabase);
  for (const t of tables.missing) problems.push(`missing table: ${t}`);
  if (tables.error) problems.push(tables.error);

  const rpc = await checkLedgerRpc(supabase);
  if (!rpc.ok) problems.push(`missing function: ${rpc.error}`);

  return { ok: problems.length === 0, missing: tables.missing, problems };
}

/** Human-readable one-liner used in boot logs. */
function describe(result) {
  if (result.ok) return 'schema OK (tables + apply_movement present)';
  return `schema problems: ${result.problems.join('; ')}`;
}

module.exports = { REQUIRED_TABLES, verifySchema, checkTables, checkLedgerRpc, describe };
