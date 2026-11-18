#!/usr/bin/env node
/**
 * Money-integrity reconciliation.
 *
 * Answers the first question in any dispute or audit: "does every stored
 * balance equal the sum of the ledger rows that explain it?"
 *
 * Run:   node scripts/reconcile.js
 * Exit:  0 = reconciled (warnings allowed), 1 = mismatch found
 *
 * Works in both modes:
 *   - Postgres: reads users + balance_ledger (service-role key) in pages.
 *   - Local memory mode: reads data/local-db.json.
 *
 * Read-only. This script never writes money.
 */
const path = require('path');
const { getSupabase, isSupabaseAvailable } = require(path.join(__dirname, '..', 'config', 'supabase'));

const CENTS = (value) => Math.round(Number(value || 0) * 100);
const PAGE = 1000;
const MAX_LEDGER_ROWS = 500_000;

function fmt(minor) {
  return (minor / 100).toFixed(2);
}

async function reconcileSupabase() {
  const supabase = getSupabase();
  const problems = [];
  const warnings = [];

  // ---- users -------------------------------------------------------------
  const users = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('users')
      .select('id, user_name, balance, held, is_banned, is_guest')
      // Stable order is required for keyset-free paging: without it, a row can
      // appear on two pages or none.
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`users read failed: ${error.message}`);
    if (!data || !data.length) break;
    users.push(...data);
    if (data.length < PAGE) break;
  }

  // ---- ledger ------------------------------------------------------------
  const totals = new Map(); // user_id -> { balance, held, rows }
  let scanned = 0;
  for (let from = 0; from < MAX_LEDGER_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from('balance_ledger')
      .select('user_id, delta, hold_delta')
      // `id` is BIGSERIAL and unique, so paging by it can never duplicate or skip
      // a row. Ordering by created_at alone is not deterministic when two rows
      // share a timestamp.
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`balance_ledger read failed: ${error.message}`);
    if (!data || !data.length) break;
    scanned += data.length;
    for (const row of data) {
      const key = String(row.user_id);
      const agg = totals.get(key) || { balance: 0, held: 0, rows: 0 };
      agg.balance += CENTS(row.delta);
      agg.held += CENTS(row.hold_delta);
      agg.rows += 1;
      totals.set(key, agg);
    }
    if (data.length < PAGE) break;
  }

  // ---- compare -----------------------------------------------------------
  for (const user of users) {
    const id = String(user.id);
    const agg = totals.get(id);
    const balance = CENTS(user.balance);
    const held = CENTS(user.held);

    if (!agg) {
      if (balance !== 0 || held !== 0) {
        warnings.push(
          `${user.user_name || id}: balance ${fmt(balance)} held ${fmt(held)} but NO ledger rows ` +
            '(legacy/imported account?)'
        );
      }
      continue;
    }

    if (agg.balance !== balance) {
      problems.push(
        `${user.user_name || id}: stored balance ${fmt(balance)} != ledger sum ${fmt(agg.balance)} ` +
          `(diff ${fmt(balance - agg.balance)}, ${agg.rows} rows)`
      );
    }
    if (agg.held !== held) {
      problems.push(
        `${user.user_name || id}: stored held ${fmt(held)} != ledger hold sum ${fmt(agg.held)} ` +
          `(diff ${fmt(held - agg.held)})`
      );
    }
  }

  // ---- fairness audit ----------------------------------------------------
  let forced = 0;
  let unverified = 0;
  try {
    const { count: forcedCount } = await supabase
      .from('game_rounds')
      .select('id', { count: 'exact', head: true })
      .eq('forced', true);
    forced = forcedCount || 0;

    const { count: badCount } = await supabase
      .from('game_rounds')
      .select('id', { count: 'exact', head: true })
      .eq('verified', false);
    unverified = badCount || 0;
  } catch (error) {
    warnings.push(`fairness audit query skipped: ${error.message}`);
  }

  return { users: users.length, ledgerRows: scanned, problems, warnings, forced, unverified };
}

function reconcileMemory() {
  const localDB = require(path.join(__dirname, '..', 'config', 'localDB'));
  const db = localDB.load();
  const users = Array.isArray(db.users) ? db.users : [];
  const ledger = Array.isArray(db.ledger) ? db.ledger : [];
  const problems = [];
  const warnings = [];

  const totals = new Map();
  for (const row of ledger) {
    const key = String(row.user_id);
    const agg = totals.get(key) || { balance: 0, held: 0, rows: 0 };
    agg.balance += CENTS(row.delta);
    agg.held += CENTS(row.hold_delta);
    agg.rows += 1;
    totals.set(key, agg);
  }

  // The durable local store keeps at most 5,000 ledger rows (services/ledger.js
  // MEM_LEDGER_LIMIT). Past that point older rows have been dropped and a sum
  // over the retained rows can no longer equal the stored balance.
  if (ledger.length >= 5000) {
    warnings.push(
      'local ledger is at its 5,000-row retention cap; balances older than the ' +
        'retained window cannot be reconciled in memory mode'
    );
  }

  for (const user of users) {
    const id = String(user.id);
    const agg = totals.get(id);
    const balance = CENTS(user.balance);
    const held = CENTS(user.held);

    if (!agg) {
      if (balance !== 0 || held !== 0) {
        warnings.push(
          `${user.user_name || id}: balance ${fmt(balance)} held ${fmt(held)} but NO ledger rows`
        );
      }
      continue;
    }
    if (agg.balance !== balance) {
      problems.push(
        `${user.user_name || id}: stored balance ${fmt(balance)} != ledger sum ${fmt(agg.balance)}`
      );
    }
    if (agg.held !== held) {
      problems.push(
        `${user.user_name || id}: stored held ${fmt(held)} != ledger hold sum ${fmt(agg.held)}`
      );
    }
  }

  return { users: users.length, ledgerRows: ledger.length, problems, warnings, forced: 0, unverified: 0 };
}

(async () => {
  try {
    const report = isSupabaseAvailable() ? await reconcileSupabase() : reconcileMemory();
    const mode = isSupabaseAvailable() ? 'POSTGRES' : 'LOCAL MEMORY';

    console.log(`\nReconciliation (${mode})`);
    console.log(`  accounts checked : ${report.users}`);
    console.log(`  ledger rows      : ${report.ledgerRows}`);
    console.log(`  forced rounds    : ${report.forced}`);
    console.log(`  unverified rounds: ${report.unverified}`);

    if (report.warnings.length) {
      console.log('\nWarnings:');
      for (const warning of report.warnings.slice(0, 50)) console.log(`  - ${warning}`);
      if (report.warnings.length > 50) console.log(`  ... ${report.warnings.length - 50} more`);
    }

    if (report.problems.length) {
      console.error('\nMISMATCHES:');
      for (const problem of report.problems.slice(0, 100)) console.error(`  x ${problem}`);
      if (report.problems.length > 100) {
        console.error(`  ... ${report.problems.length - 100} more`);
      }
      console.error(`\nFAILED: ${report.problems.length} mismatch(es).\n`);
      process.exit(1);
    }

    if (report.unverified > 0) {
      console.error(
        `\nCRITICAL: ${report.unverified} round(s) have a crash point that does not match ` +
          'their published seeds. Investigate before taking further bets.\n'
      );
      process.exit(1);
    }

    console.log('\nOK: every stored balance reconciles to its ledger.\n');
    process.exit(0);
  } catch (error) {
    console.error('\nReconciliation could not complete:', error.message);
    process.exit(2);
  }
})();
