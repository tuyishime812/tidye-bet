/**
 * Supabase (Postgres) client.
 *
 * SECURITY (CWE-250) — WHY THIS FILE USED TO BE A PROBLEM
 * --------------------------------------------------------
 * The client was built with SUPABASE_KEY, which is the *anon* key. That key is
 * shipped to every browser, so anything it can do, an attacker can do. Three
 * concrete failures followed from that:
 *
 *   1. The atomic balance RPC is granted to `service_role` only (see SCHEMA.sql).
 *      Calling apply_balance_delta with the anon key fails with
 *      "permission denied for function apply_balance_delta" — so the one race
 *      -safe way to move money was unusable, and the only working code path was
 *      the unsafe read-then-write one.
 *
 *   2. The old schema also created `CREATE POLICY "Allow all operations on
 *      users" ... USING (true)`. RLS enabled + permit-all policy = the anon key
 *      could read every row of users, including the bcrypt `password` column and
 *      every player's `balance`. That is a complete compromise of the platform.
 *
 *   3. Any table with RLS enabled and no matching policy is invisible to the
 *      anon key, so reads silently returned empty arrays rather than failing.
 *
 * The backend must therefore use SUPABASE_SERVICE_ROLE_KEY. It bypasses RLS,
 * which is correct for a trusted backend, but it MUST never reach the browser —
 * so it is read from the server's environment only, and never shipped in any
 * API response.
 *
 * MODE SELECTION
 * --------------
 * USE_SUPABASE=true + a configured service_role key => Postgres.
 * Otherwise => in-memory mode, so the project still runs with no database.
 * Money invariants are enforced in BOTH modes; see services/ledger.js.
 */
const dotenv = require('dotenv');

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The original async createClient() resolved lazily on first request, so
// `available` was briefly true before the client existed and every early call
// threw "Cannot read properties of undefined". Building it synchronously
// removes that window entirely.
let supabase = null;
let mode = 'memory';
let unavailableReason = 'USE_SUPABASE is not "true"';

if (process.env.USE_SUPABASE === 'true') {
  if (!supabaseUrl || !anonKey) {
    unavailableReason = 'USE_SUPABASE=true but SUPABASE_URL / SUPABASE_KEY are not set';
    console.error(`\n❌ Supabase misconfigured: ${unavailableReason}`);
    console.error('   Falling back to in-memory mode. Data will NOT persist.\n');
  } else if (!serviceRoleKey) {
    unavailableReason = 'SUPABASE_SERVICE_ROLE_KEY is not set';
    // This is fatal-by-design rather than silently downgraded: without the
    // service_role key the server CANNOT move money atomically, and running
    // anyway would silently push every balance change onto the unsafe
    // read-then-write path. Failing closed is the correct trade-off.
    console.error(
      '\n[FATAL] USE_SUPABASE=true requires SUPABASE_SERVICE_ROLE_KEY.\n' +
      '         The backend needs it to call apply_balance_delta(), which is the\n' +
      '         only race-safe way to move money and is granted to service_role\n' +
      '         alone. The anon key is present in every browser and MUST NOT be\n' +
      '         used server-side.\n' +
      '         Set it in server/.env, or set USE_SUPABASE=false for local dev.\n'
    );
    process.exit(1);
  } else {
    // Required lazily: @supabase/supabase-js is only present with the DB deps.
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { 'X-Client-Info': 'aviator-crash-server' }
      }
    });
    mode = 'supabase';
  }
}

function getSupabase() {
  return supabase;
}

function isSupabaseAvailable() {
  return mode === 'supabase' && !!supabase;
}

/** 'supabase' | 'memory' — used for logging and for refusing unsafe paths. */
function getStorageMode() {
  return mode;
}

function getUnavailableReason() {
  return unavailableReason;
}

/**
 * Supabase Auth (GoTrue) configuration.
 *
 * These are separate from the PostgREST/data mode above on purpose: admin
 * sign-in can use Supabase Auth even when balances still live in memory, so the
 * auth helpers must not be gated behind USE_SUPABASE. The *anon* key is the
 * correct credential for a password-grant sign-in (it is the same public key a
 * browser uses); the service-role key also works but is more privileged than
 * this operation needs, so it is only a fallback.
 */
function getSupabaseUrl() {
  return supabaseUrl || null;
}

function getSupabaseAnonKey() {
  return anonKey || null;
}

function getSupabaseServiceKey() {
  return serviceRoleKey || null;
}

/** The credential used to call GoTrue: prefer the public anon key. */
function getSupabaseAuthKey() {
  return anonKey || serviceRoleKey || null;
}

/** True when we can reach Supabase Auth (URL + some apikey present). */
function isSupabaseAuthConfigured() {
  return Boolean(supabaseUrl && (anonKey || serviceRoleKey));
}

module.exports = {
  getSupabase,
  isSupabaseAvailable,
  getStorageMode,
  getUnavailableReason,
  getSupabaseUrl,
  getSupabaseAnonKey,
  getSupabaseServiceKey,
  getSupabaseAuthKey,
  isSupabaseAuthConfigured
};