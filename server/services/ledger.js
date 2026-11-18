/**
 * THE money module. Every MWK that enters or leaves a player's balance goes
 * through moveBalance() and nothing else.
 *
 * WHY A SINGLE CHOKE POINT
 * ------------------------
 * Before this existed, balance changes were scattered across routes and game
 * logic, each doing its own read-then-write:
 *
 *     const { data } = await supabase.from('users').select('balance')...
 *     await supabase.from('users').update({ balance: data.balance - amount })
 *
 * That pattern is a double-spend (CWE-362): two concurrent withdrawals both read
 * the same starting balance, both observe "sufficient funds", and both succeed.
 * The user ends up with more money than they had.
 *
 * This module makes that impossible by construction:
 *   - Postgres: calls apply_movement(), one statement that moves BOTH the
 *     balance and the escrow bucket and writes the ledger row, under a single
 *     `SELECT ... FOR UPDATE`. Concurrent callers are serialised by the
 *     database, not by luck.
 *   - Memory: a strict FIFO promise queue per user, so the read-check-write
 *     sequence cannot interleave. Identical invariants, enforced in-process.
 *
 * It also guarantees the audit trail: the ledger row is written in the same
 * transaction (Postgres) or the same critical section (memory) as the movement,
 * so a movement can never exist without its record.
 *
 * THE TWO BUCKETS (must match SCHEMA.sql SECTION 3 exactly)
 * --------------------------------------------------------
 *   balance  money the player can spend
 *   held     money escrowed by a pending withdrawal - DISJOINT from balance
 *
 * A hold MOVES money out of balance into held, so `balance` already excludes
 * escrowed funds and spendable money is just `balance`. There is deliberately
 * no `available = balance - held` subtraction anywhere in a spend path: a rule
 * that every one of N callers must remember is a rule the N+1'th caller forgets,
 * and the failure is held funds being bet while a withdrawal is in flight.
 *
 * Every call REQUIRES a reason from a fixed vocabulary, and each reason has a
 * fixed bucket shape. An unexplained or mis-shaped balance change is a bug or
 * an attack, and this makes both fail loudly.
 */
const { getSupabase, isSupabaseAvailable } = require('../config/supabase');
const memoryStore = require('../config/memoryStore');
const localDB = require('../config/localDB');
const { toMinor, fromMinor } = require('../config/money');

/** The only permitted reasons money can move. Mirrors the CHECK in SCHEMA.sql. */
const REASONS = Object.freeze({
  DEPOSIT: 'DEPOSIT',
  WITHDRAWAL_HOLD: 'WITHDRAWAL_HOLD',
  WITHDRAWAL_REFUND: 'WITHDRAWAL_REFUND',
  WITHDRAWAL_PAID: 'WITHDRAWAL_PAID',
  BET_STAKE: 'BET_STAKE',
  BET_PAYOUT: 'BET_PAYOUT',
  BET_REFUND: 'BET_REFUND',
  ADMIN_CREDIT: 'ADMIN_CREDIT',
  ADMIN_DEBIT: 'ADMIN_DEBIT',
  BONUS: 'BONUS',
  ADJUSTMENT: 'ADJUSTMENT'
});

const VALID_REASONS = new Set(Object.values(REASONS));

// ---------------------------------------------------------------------------
// In-memory ledger + per-user serialisation
// ---------------------------------------------------------------------------

/** Append-only, newest first. Mirrors the balance_ledger table. */
const memLedger = [];
const MEM_LEDGER_LIMIT = 5000;

// Hydrate the local ledger so a player's wallet history survives a restart in
// durable local mode. Newest-first ordering is preserved.
(function hydrateLedger() {
  const db = localDB.load();
  const rows = Array.isArray(db.ledger) ? db.ledger : [];
  for (const row of rows) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      memLedger.push(row);
    }
  }
  if (memLedger.length > MEM_LEDGER_LIMIT) memLedger.length = MEM_LEDGER_LIMIT;
  if (rows.length) {
    console.log(`[local-db] Loaded ${memLedger.length} ledger row(s) from disk.`);
  }
})();

localDB.register('ledger', () => memLedger.slice(0, MEM_LEDGER_LIMIT));

/**
 * One promise chain per user id. Every mutation for a user is appended to that
 * user's chain, so a balance read-modify-write can never interleave with
 * another for the same user. Different users still run in parallel.
 */
const userQueues = new Map();

/**
 * Run `fn` with exclusive access to `userId`'s balance.
 *
 * This is the memory-mode equivalent of Postgres' row lock. It is what makes
 * the read-check-write sequence atomic without a database.
 */
function withUserLock(userId, fn) {
  const key = String(userId);
  const previous = userQueues.get(key) || Promise.resolve();

  // Chain onto the previous task. Note `.then(fn, fn)` so a rejected predecessor
  // does not permanently poison the chain.
  const run = previous.then(fn, fn);

  // Keep the chain alive but never let a rejection escape or become unhandled.
  const guarded = run.then(
    (v) => v,
    (e) => {
      throw e;
    }
  );

  userQueues.set(
    key,
    guarded.then(
      () => undefined,
      () => undefined
    )
  );

  return guarded;
}

function pushLedgerEntry(entry) {
  memLedger.unshift(entry);
  if (memLedger.length > MEM_LEDGER_LIMIT) memLedger.length = MEM_LEDGER_LIMIT;
  // Persist together with the users map so a balance and the row that explains
  // it are never written separately.
  localDB.scheduleSave();
}

/** Ledger rows for a user, newest first (memory mode). */
function ledgerForUser(userId, limit = 100) {
  return memLedger.filter((e) => e.user_id === String(userId)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Bucket-shape validation - the JavaScript mirror of apply_movement()'s checks
// ---------------------------------------------------------------------------

/**
 * Enforce the fixed (balance, held) shape each reason is allowed to have.
 *
 * This runs in BOTH modes, because a bug in an admin tool should be caught in
 * dev (memory) with a clear message rather than first surfacing as an opaque
 * Postgres error in production.
 *
 * @param {number} amountMinor signed balance delta
 * @param {number} holdMinor   signed held delta
 * @param {string} reason
 * @returns {string|null} an error reason, or null when the shape is valid
 */
function checkBucketShape(amountMinor, holdMinor, reason) {
  if (reason === REASONS.WITHDRAWAL_HOLD) {
    if (!(holdMinor > 0 && amountMinor === -holdMinor)) {
      return 'WITHDRAWAL_HOLD must move X out of balance and into held';
    }
    return null;
  }
  if (reason === REASONS.WITHDRAWAL_REFUND) {
    if (!(holdMinor < 0 && amountMinor === -holdMinor)) {
      return 'WITHDRAWAL_REFUND must move X out of held and into balance';
    }
    return null;
  }
  if (reason === REASONS.WITHDRAWAL_PAID) {
    if (!(amountMinor === 0 && holdMinor < 0)) {
      return 'WITHDRAWAL_PAID must consume held without touching balance';
    }
    return null;
  }
  if (holdMinor !== 0) return 'only withdrawal reasons may touch the held bucket';
  if (amountMinor === 0) return 'Invalid amount';

  // Sign of the balance delta per reason (M-C from SCHEMA_AUDIT.md). The
  // intent-named helpers below already pin the sign, but moveBalance() is a
  // public function and a future caller must not be able to label a debit as a
  // DEPOSIT and corrupt every reconciliation that groups by reason.
  const positiveOnly = new Set([
    REASONS.DEPOSIT,
    REASONS.BET_PAYOUT,
    REASONS.BET_REFUND,
    REASONS.ADMIN_CREDIT,
    REASONS.BONUS
  ]);
  const negativeOnly = new Set([REASONS.BET_STAKE, REASONS.ADMIN_DEBIT]);

  if (positiveOnly.has(reason) && amountMinor <= 0) {
    return `${reason} must increase the balance`;
  }
  if (negativeOnly.has(reason) && amountMinor >= 0) {
    return `${reason} must decrease the balance`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Move money between the balance bucket and the escrow bucket.
 *
 * @param {object}  opts
 * @param {string}  opts.userId
 * @param {number}  opts.amountMinor  Signed balance delta. Negative debits.
 * @param {number} [opts.holdMinor]   Signed escrow delta. Defaults to 0.
 * @param {string}  opts.reason       One of REASONS.
 * @param {string} [opts.refType]     'deposit' | 'withdrawal' | 'bet' | null
 * @param {string} [opts.refId]
 * @param {object} [opts.metadata]    Context. Never include secrets/OTPs.
 * @returns {Promise<{ok:boolean, balance?:number, held?:number, reason?:string}>}
 *          balance and held are in MINOR units.
 */
async function moveBalance({
  userId,
  amountMinor,
  holdMinor = 0,
  reason,
  refType = null,
  refId = null,
  metadata = {}
}) {
  // ---- Validate before touching storage (CWE-20) -------------------------
  if (!userId || typeof userId !== 'string') {
    return { ok: false, reason: 'Invalid user' };
  }
  if (!Number.isInteger(amountMinor) || !Number.isInteger(holdMinor)) {
    // Integer-only: a float delta means the caller did not convert properly.
    return { ok: false, reason: 'Invalid amount' };
  }
  if (!VALID_REASONS.has(reason)) {
    // An unexplained balance change is either a bug or an attack.
    return { ok: false, reason: 'Invalid reason' };
  }

  const shapeError = checkBucketShape(amountMinor, holdMinor, reason);
  if (shapeError) return { ok: false, reason: shapeError };

  // ---- Postgres ----------------------------------------------------------
  if (isSupabaseAvailable()) {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('apply_movement', {
      p_user_id: userId,
      p_balance_delta: amountMinor / 100, // RPC works in major units (NUMERIC)
      p_hold_delta: holdMinor / 100,
      p_reason: reason,
      p_ref_type: refType,
      p_ref_id: refId,
      p_metadata: metadata
    });

    if (error) {
      console.error('[ledger] apply_movement failed:', error.message);
      return { ok: false, reason: 'Balance update failed' };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.success !== true) {
      return { ok: false, reason: (row && row.reason_out) || 'Balance update failed' };
    }
    return { ok: true, balance: toMinor(row.balance) || 0, held: toMinor(row.held) || 0 };
  }

  // ---- Memory mode -------------------------------------------------------
  return withUserLock(userId, () => {
    const user = memoryStore.findUserById(userId);
    if (!user) return { ok: false, reason: 'User not found' };

    const balBefore = toMinor(user.balance);
    if (balBefore === null) {
      // A non-numeric stored balance means prior corruption; refuse to compound it.
      return { ok: false, reason: 'Corrupt balance' };
    }
    const holdBefore = heldMinor(user);

    const balAfter = balBefore + amountMinor;
    const holdAfter = holdBefore + holdMinor;

    // Same two guards as the SQL, in the same order, for the same reasons.
    if (balAfter < 0) return { ok: false, reason: 'Insufficient balance' };
    if (holdAfter < 0) return { ok: false, reason: 'Invalid hold release' };

    // Both buckets are written together, inside the lock, before the ledger row
    // is appended - the memory-mode equivalent of one Postgres transaction.
    user.balance = fromMinor(balAfter);
    user.held = fromMinor(holdAfter);

    pushLedgerEntry({
      user_id: String(userId),
      delta: fromMinor(amountMinor),
      balance_before: fromMinor(balBefore),
      balance_after: fromMinor(balAfter),
      hold_delta: fromMinor(holdMinor),
      hold_before: fromMinor(holdBefore),
      hold_after: fromMinor(holdAfter),
      reason,
      ref_type: refType,
      ref_id: refId,
      metadata,
      created_at: new Date().toISOString()
    });

    return { ok: true, balance: balAfter, held: holdAfter };
  });
}

/** Read the memory-mode `held` bucket, defaulting to 0 for older user records. */
function heldMinor(user) {
  const h = toMinor(user.held);
  return h === null ? 0 : h;
}

// ---------------------------------------------------------------------------
// Intent-named helpers. Call sites should read as what is happening, never as
// arithmetic - that is how the C-3 unit bug happened in the first place.
//
// The `reason` is pinned by each helper rather than passed by the caller, so a
// caller cannot label an escrowed movement as a deposit (which would corrupt
// any later reconciliation by reason).
// ---------------------------------------------------------------------------

/**
 * Money in. Defaults to DEPOSIT; callers with a more specific reason (bet
 * payout, refund) may pass one from REASONS - the bucket-shape check still
 * rejects any withdrawal-shaped misuse even through this helper.
 */
const credit = ({ userId, amountMinor, reason = REASONS.DEPOSIT, refType = null, refId = null, metadata = {} }) =>
  moveBalance({
    userId,
    reason,
    amountMinor: Math.abs(amountMinor),
    holdMinor: 0,
    refType,
    refId,
    metadata
  });

/**
 * Money out of the spendable balance.
 *
 * The reason is intentionally caller-supplied here because a debit legitimately
 * happens for several reasons (stake, admin debit); the caller picks the
 * accurate one from REASONS. Held is never touched.
 */
const debit = ({ userId, amountMinor, reason, refType = null, refId = null, metadata = {} }) =>
  moveBalance({
    userId,
    reason,
    amountMinor: -Math.abs(amountMinor),
    holdMinor: 0,
    refType,
    refId,
    metadata
  });

/**
 * Escrow funds for a pending withdrawal: balance -X, held +X.
 * Fails with 'Insufficient balance' when the player cannot cover it, which is
 * checked against the balance the player can actually see - no separate
 * `balance - held` subtraction for the caller to forget.
 */
const placeHold = ({ userId, amountMinor, refType = null, refId = null, metadata = {} }) =>
  moveBalance({
    userId,
    reason: REASONS.WITHDRAWAL_HOLD,
    amountMinor: -Math.abs(amountMinor),
    holdMinor: Math.abs(amountMinor),
    refType,
    refId,
    metadata
  });

/** Return escrowed funds: balance +X, held -X. Used on reject or cancel. */
const refundHold = ({ userId, amountMinor, refType = null, refId = null, metadata = {} }) =>
  moveBalance({
    userId,
    reason: REASONS.WITHDRAWAL_REFUND,
    amountMinor: Math.abs(amountMinor),
    holdMinor: -Math.abs(amountMinor),
    refType,
    refId,
    metadata
  });

/**
 * Consume escrow after a successful payout: balance unchanged, held -X.
 *
 * The money left the balance when the hold was placed, so crediting the balance
 * here would pay the withdrawal twice. This is the step an optimistically-PAID
 * implementation forgets, leaving `held` permanently inflated.
 */
const releaseHold = ({ userId, amountMinor, refType = null, refId = null, metadata = {} }) =>
  moveBalance({
    userId,
    reason: REASONS.WITHDRAWAL_PAID,
    amountMinor: 0,
    holdMinor: -Math.abs(amountMinor),
    refType,
    refId,
    metadata
  });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Read a player's balance.
 * @returns {Promise<{ok:boolean, balance?:number, held?:number, reason?:string}>}
 *          Minor units.
 */
async function getBalance(userId) {
  if (!userId || typeof userId !== 'string') {
    return { ok: false, reason: 'Invalid user' };
  }

  if (isSupabaseAvailable()) {
    const supabase = getSupabase();
    // Only the two money columns are selected: this function must never be a
    // way to pull the whole user row (including the password hash).
    const { data, error } = await supabase
      .from('users')
      .select('balance, held')
      .eq('id', userId)
      .single();

    if (error || !data) return { ok: false, reason: 'User not found' };
    return { ok: true, balance: toMinor(data.balance) || 0, held: toMinor(data.held) || 0 };
  }

  const user = memoryStore.findUserById(userId);
  if (!user) return { ok: false, reason: 'User not found' };
  return { ok: true, balance: toMinor(user.balance) || 0, held: heldMinor(user) };
}

/**
 * Money available to spend.
 *
 * equals `balance`, because escrowed funds were moved OUT of balance when the
 * hold was placed (see the header). `held` is reported separately for display
 * only - do not subtract it here or anywhere else; doing so would charge a
 * player for the same money twice.
 */
async function getAvailable(userId) {
  const b = await getBalance(userId);
  if (!b.ok) return b;
  return { ok: true, balance: b.balance, held: b.held, available: b.balance };
}

/** Read a player's ledger from the database (memory mode reads memLedger). */
async function getLedger(userId, limit = 50) {
  if (!userId || typeof userId !== 'string') {
    return { ok: false, reason: 'Invalid user' };
  }
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);

  if (isSupabaseAvailable()) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('balance_ledger')
      .select(
        'delta, balance_before, balance_after, hold_delta, hold_before, hold_after, reason, ref_type, ref_id, created_at'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(capped);
    if (error) return { ok: false, reason: 'Could not read history' };
    return { ok: true, entries: data || [] };
  }

  return { ok: true, entries: ledgerForUser(userId, capped) };
}

/**
 * Self-check for memory mode: the ledger must reconcile against the stored
 * balance. Used by tests to prove the memory implementation cannot drift from
 * the totals it claims to have produced.
 */
function reconcileMemory(userId) {
  const entries = ledgerForUser(userId, MEM_LEDGER_LIMIT);
  let bal = 0;
  let held = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    // Entries are stored in major units (like the DB). Convert with plain
    // arithmetic - NOT toMinor(), which is a client-input parser that
    // deliberately rejects negative numbers (see config/money.js), so it would
    // silently zero out every debit and hold row.
    bal += Math.round(Number(e.delta) * 100);
    held += Math.round(Number(e.hold_delta || 0) * 100);
  }
  return { balanceMinor: bal, heldMinor: held, rows: entries.length };
}

module.exports = {
  REASONS,
  moveBalance,
  credit,
  debit,
  placeHold,
  refundHold,
  releaseHold,
  getBalance,
  getAvailable,
  getLedger,
  withUserLock,
  reconcileMemory
};
