/**
 * Durable Aviator bet + round history for local (no-Supabase) mode.
 *
 * WHY THIS EXISTS
 * ---------------
 * `routes/game.js` used to return an empty list for My Bets, the top-bets
 * leaderboard, round history and the provably-fair verifier whenever Supabase
 * was not configured. That is the default way the app is run locally, so four
 * advertised features were silently dead: a player could not see what they had
 * bet on, and could not verify a single round even though the crash point is
 * derived deterministically from published seeds.
 *
 * This module stores the same rows the Supabase path writes, in the existing
 * durable local store (config/localDB.js), and exposes the read helpers the
 * routes need. It is intentionally small: append + query + cap.
 *
 * INTEGRITY
 * ---------
 *  - Rows are plain objects with fixed fields; nothing from the wire is spread
 *    into a stored record, so a caller cannot smuggle `__proto__` or `id`.
 *  - Collections are capped so a long-running local deployment cannot grow the
 *    JSON file without bound.
 *  - Persistence is debounced/atomic via localDB.
 */
const localDB = require('./localDB');

/** Keep the durable file bounded. Oldest rows are dropped first. */
const MAX_BETS = 20000;
const MAX_ROUNDS = 5000;

let bets = [];
let rounds = [];
let betSeq = 1;
let roundSeq = 1;

function clampLimit(limit, fallback, max) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeString(value, maxLength = 300) {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLength);
}

function hydrate() {
  const db = localDB.load();
  const storedBets = Array.isArray(db.crashBets) ? db.crashBets : [];
  const storedRounds = Array.isArray(db.crashRounds) ? db.crashRounds : [];

  bets = storedBets
    .filter((row) => row && typeof row === 'object')
    .map((row, index) => ({
      id: safeNumber(row.id, index + 1),
      user_id: safeString(row.user_id, 120),
      user_name: safeString(row.user_name, 80),
      bet_amount: safeNumber(row.bet_amount),
      cash_out_at: safeNumber(row.cash_out_at),
      cashouted: row.cashouted === true,
      fly_away: safeNumber(row.fly_away),
      fly_detail_id: safeString(row.fly_detail_id, 160),
      profit: safeNumber(row.profit),
      game_round: safeNumber(row.game_round),
      created_at: safeString(row.created_at, 40) || new Date().toISOString(),
    }));

  rounds = storedRounds
    .filter((row) => row && typeof row === 'object')
    .map((row, index) => ({
      id: safeNumber(row.id, index + 1),
      round_number: safeNumber(row.round_number),
      crash_point: safeNumber(row.crash_point),
      server_seed: safeString(row.server_seed, 256),
      server_seed_hash: safeString(row.server_seed_hash, 256),
      client_seeds: Array.isArray(row.client_seeds)
        ? row.client_seeds.filter((seed) => typeof seed === 'string').slice(0, 256)
        : [],
      fly_detail_id: safeString(row.fly_detail_id, 160),
      forced: row.forced === true,
      forced_by: row.forced_by ? safeString(row.forced_by, 120) : null,
      verified: row.verified === true ? true : row.verified === false ? false : null,
      created_at: safeString(row.created_at, 40) || new Date().toISOString(),
    }));

  betSeq = bets.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  roundSeq = rounds.reduce((max, row) => Math.max(max, row.id), 0) + 1;

  if (bets.length || rounds.length) {
    console.log(
      `[local-db] Loaded ${bets.length} crash bet(s) and ${rounds.length} crash round(s) from disk.`
    );
  }
}

hydrate();

// Provide the collections to the atomic writer. register() is idempotent for a
// given name, so this is safe if the module is ever required twice in tests.
localDB.register('crashBets', () => bets);
localDB.register('crashRounds', () => rounds);

function recordBet(input) {
  if (!input || typeof input !== 'object') return null;
  const row = {
    id: betSeq++,
    user_id: safeString(input.userId, 120),
    user_name: safeString(input.userName, 80) || 'Player',
    bet_amount: safeNumber(input.betAmount),
    cash_out_at: safeNumber(input.cashOutAt),
    cashouted: input.cashouted === true,
    fly_away: safeNumber(input.flyAway),
    fly_detail_id: safeString(input.flyDetailID, 160),
    profit: safeNumber(input.profit),
    game_round: safeNumber(input.round),
    created_at: new Date().toISOString(),
  };
  bets.push(row);
  if (bets.length > MAX_BETS) bets.splice(0, bets.length - MAX_BETS);
  localDB.scheduleSave();
  return { ...row };
}

function recordRound(input) {
  if (!input || typeof input !== 'object') return null;
  const row = {
    id: roundSeq++,
    round_number: safeNumber(input.roundNumber),
    crash_point: safeNumber(input.crashPoint),
    server_seed: safeString(input.serverSeed, 256),
    server_seed_hash: safeString(input.serverSeedHash, 256),
    client_seeds: Array.isArray(input.clientSeeds)
      ? input.clientSeeds.filter((seed) => typeof seed === 'string').slice(0, 256)
      : [],
    fly_detail_id: safeString(input.flyDetailID, 160),
    forced: input.forced === true,
    forced_by: input.forced && input.forcedBy ? safeString(input.forcedBy, 120) : null,
    verified: input.verified === true ? true : input.verified === false ? false : null,
    created_at: new Date().toISOString(),
  };
  rounds.push(row);
  if (rounds.length > MAX_ROUNDS) rounds.splice(0, rounds.length - MAX_ROUNDS);
  localDB.scheduleSave();
  return { ...row };
}

function listUserBets(userId, limit = 50) {
  const uid = safeString(userId, 120);
  if (!uid) return [];
  return bets
    .filter((row) => row.user_id === uid)
    .sort((a, b) => b.id - a.id)
    .slice(0, clampLimit(limit, 50, 200))
    .map((row) => ({ ...row }));
}

function listTopBets(limit = 20) {
  return bets
    .filter((row) => row.cashouted && row.profit > 0)
    .sort((a, b) => b.profit - a.profit)
    .slice(0, clampLimit(limit, 20, 100))
    .map((row) => ({ ...row }));
}

function listHistory(limit = 50) {
  return rounds
    .slice()
    .sort((a, b) => b.round_number - a.round_number)
    .slice(0, clampLimit(limit, 50, 200))
    .map((row) => row.crash_point);
}

function findRound(roundNumber) {
  const wanted = Number(roundNumber);
  if (!Number.isFinite(wanted)) return null;
  const row = rounds.find((entry) => entry.round_number === wanted);
  return row ? { ...row } : null;
}

/** Test/dev helper. Never called by production code. */
function reset() {
  bets = [];
  rounds = [];
  betSeq = 1;
  roundSeq = 1;
}

module.exports = {
  recordBet,
  recordRound,
  listUserBets,
  listTopBets,
  listHistory,
  findRound,
  reset
};
