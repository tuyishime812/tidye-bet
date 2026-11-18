/**
 * Wallet API: deposits, withdrawals and balances.
 *
 * Replaces routes/payment.js, whose deposit webhook was completely
 * unauthenticated (Critical C-1 in SECURITY_REPORT.md §2). Every balance
 * movement here goes through services/ledger.js — this file never writes
 * users.balance itself.
 *
 * ROUTE MAP
 *   GET    /wallet                  balance + available + holds        (player)
 *   GET    /methods                 supported deposit/payout methods   (public)
 *   GET    /config                  server-driven payment display data (public)
 *   POST   /deposits                start a deposit (hosted checkout)  (player)
 *   GET    /deposits                own deposit history                (player)
 *   GET    /deposits/:txRef/status  verify a PayChangu deposit         (player)
 *   POST   /withdrawals             request a withdrawal (funds HELD)  (player)
 *   GET    /withdrawals             own withdrawal history             (player)
 *   POST   /withdrawals/:id/cancel  cancel own PENDING withdrawal      (player)
 *   GET    /admin/withdrawals       approval queue                     (admin)
 *   POST   /admin/withdrawals/:id/approve   send + settle              (admin)
 *   POST   /admin/withdrawals/:id/reject    refund the hold            (admin)
 *   POST   /admin/credits           manual balance adjustment          (admin)
 */
const crypto = require('crypto');
const express = require('express');
const {
  requireAuth,
  requireActivePlayer,
  requireAdmin,
  apiRateLimit,
  credentialLimiter
} = require('../middleware/auth');
const { getSupabase, isSupabaseAvailable } = require('../config/supabase');
const memoryStore = require('../config/memoryStore');
const { toMinor, fromMinor, feeFromMinor, formatMinor } = require('../config/money');
const ledger = require('../services/ledger');
const paychangu = require('../services/paychangu');
const payout = require('../services/payout');
const { writeAuditLog } = require('../services/audit');

const router = express.Router();

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const MIN_DEPOSIT_MINOR = toMinor(100);          // 100 MWK
const MAX_DEPOSIT_MINOR = toMinor(5_000_000);    // 5,000,000 MWK
const MIN_WITHDRAWAL_MINOR = toMinor(500);       // 500 MWK
const MAX_WITHDRAWAL_MINOR = toMinor(1_000_000); // 1,000,000 MWK
const WITHDRAWAL_FEE_PERCENT = 2;

// In-memory stores for dev mode. Keyed by token/id.
const memDeposits = new Map();
const memWithdrawals = new Map();
let seq = 1;

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(
    Math.random() * 1e6
  ).toString(36)}`;
}

/** Player-facing origin (browser redirects after checkout). */
function frontendBaseUrl() {
  return String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/** True for hosts a real paying customer cannot reach. */
function isUnreachableHost(host) {
  if (!host) return true;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
  );
}

/**
 * One-time startup check for the worst payment misconfiguration: a live
 * gateway sending the customer back to an origin they cannot reach. PayChangu
 * is always the live API (services/paychangu.js hardcodes it), so "configured"
 * means real money. Checkout's callback/return URLs are built from
 * FRONTEND_URL, so a localhost value charges the player and then strands them
 * on a dead page. Warn loudly at boot instead of failing at the worst moment.
 */
function warnOnUnsafePaymentConfig() {
  if (!paychangu.isConfigured()) return;
  let host = '';
  try {
    host = new URL(frontendBaseUrl()).hostname.toLowerCase();
  } catch (_) {
    host = '';
  }
  if (isUnreachableHost(host)) {
    console.warn(
      '\n⚠️  PayChangu is configured but FRONTEND_URL is not public: ' +
        `${frontendBaseUrl()}\n` +
        '   Checkout callback/return URLs point at this origin, so paying customers\n' +
        '   will be redirected to a page they cannot reach. Set FRONTEND_URL to the\n' +
        '   public site origin before taking live payments.\n'
    );
  }
}

warnOnUnsafePaymentConfig();

/**
 * Unique, unguessable reference for a PayChangu transaction. This is the value
 * we later verify against the gateway; it must never be sequential.
 */
function newGatewayRef() {
  return `pch_${crypto.randomBytes(16).toString('hex')}`;
}

function isGatewayRef(value) {
  return /^pch_[a-f0-9]{32}$/.test(String(value || ''));
}

/** Write an audit row. Never throws, never blocks the response. */
async function audit(req, action, userId, details, status = 'success', actor = null) {
  await writeAuditLog({
    action,
    userId: userId || null,
    actor: actor || null,
    details: details || {},
    status,
    ip: req && req.ip ? req.ip : null
  });
}

/** Reject a non-money / out-of-range amount with a usable message. */
function validateAmount(amountMinor, minMinor, maxMinor, label) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return `${label} must be a positive amount`;
  }
  if (amountMinor < minMinor) return `Minimum ${label.toLowerCase()} is ${fromMinor(minMinor)} MWK`;
  if (amountMinor > maxMinor) return `Maximum ${label.toLowerCase()} is ${fromMinor(maxMinor)} MWK`;
  return null;
}

// ---------------------------------------------------------------------------
// PayChangu (hosted checkout) helpers
// ---------------------------------------------------------------------------
// The merchant reference lives in `deposits.provider_ref`, which carries the
// unique partial index that makes settlement idempotent across the browser-poll
// and status paths.

async function findPayChanguDeposit(txRef, userId) {
  if (isSupabaseAvailable()) {
    let query = getSupabase()
      .from('deposits')
      .select('*')
      .eq('provider_ref', txRef)
      .eq('method', 'paychangu');
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data || null;
  }

  const record = memDeposits.get(txRef) || null;
  if (!record) return null;
  if (record.method !== 'paychangu') return null;
  if (userId && record.user_id !== userId) return null;
  return record;
}

/**
 * Clear the quick-play flag once real money has landed.
 *
 * Best-effort: a flag update must not roll back a deposit that was already
 * credited (the player would then have paid and received nothing).
 */
async function clearGuestFlag(userId) {
  try {
    if (isSupabaseAvailable()) {
      await getSupabase()
        .from('users')
        .update({ is_guest: false })
        .eq('id', userId)
        .eq('is_guest', true);
      return;
    }
    const user = memoryStore.findUserById(userId);
    if (user && user.is_guest) memoryStore.updateUser(userId, { is_guest: false });
  } catch (error) {
    console.error('[payments] could not clear guest flag:', error.message);
  }
}

/**
 * Credit a verified PayChangu payment exactly once.
 *
 * The gateway response is authoritative, but it is still validated against the
 * amount/currency WE recorded: a compromised or buggy checkout must never be
 * able to turn a 100 MWK payment into a 100,000 MWK balance.
 */
async function settlePayChanguDeposit(req, deposit, verification) {
  const expectedMinor = toMinor(deposit.amount);
  const check = paychangu.validateSettlement({ expectedMinor, verification });

  if (!check.ok) {
    // Terminal gateway outcomes (declined / wrong currency / underpaid) must
    // not sit PENDING forever. Pending/unreadable outcomes stay open for the
    // return poll.
    if (check.terminal) {
      const reason =
        check.reason === 'underpaid'
          ? 'underpaid'
          : check.reason === 'currency_mismatch'
            ? 'gateway currency mismatch'
            : `gateway ${verification && verification.status ? verification.status : 'declined'}`;
      await failDeposit(deposit, reason, {
        reference: verification && verification.reference
      });
      return { credited: false, status: 'FAILED', reason: check.reason };
    }
    return { credited: false, status: deposit.status, reason: check.reason || 'not_paid' };
  }

  const claimed = await claimDeposit(deposit.id, {
    amountMinor: check.gatewayAmountMinor,
    ref: (verification && verification.reference) || null
  });
  if (!claimed) {
    return { credited: false, status: 'COMPLETED', alreadyProcessed: true };
  }

  // Credit the amount the player asked to deposit, not an overpayment. The
  // excess is visible in gateway_amount for support/refund handling.
  const creditResult = await ledger.credit({
    userId: deposit.user_id,
    amountMinor: check.amountMinor,
    refType: 'deposit',
    refId: deposit.id,
    metadata: {
      gateway: 'paychangu',
      txRef: deposit.provider_ref,
      gatewayAmountMinor: check.gatewayAmountMinor
    }
  });

  if (!creditResult.ok) {
    await unclaimDeposit(deposit.id);
    console.error('[payments] paychangu deposit credit failed:', creditResult.reason);
    return { credited: false, status: 'PENDING', reason: 'credit_failed', error: true };
  }

  // A real, settled deposit converts a quick-play account into a normal one.
  // Guest demo credit must never be withdrawable; unlocking on the first
  // completed deposit keeps the "try before you register" UX without turning it
  // into a free-money cash-out.
  await clearGuestFlag(deposit.user_id);

  await audit(req, 'DEPOSIT_COMPLETED', deposit.user_id, {
    depositId: deposit.id,
    amount: Number(deposit.amount),
    gateway: 'paychangu'
  });

  return { credited: true, status: 'COMPLETED' };
}

/**
 * Create a PENDING deposit, initialise the hosted checkout, and hand the player
 * the redirect URL. If initialisation fails the deposit is marked FAILED so no
 * dangling PENDING row can later be settled by an unrelated payment.
 */
async function startPayChanguDeposit(req, res, amountMinor) {
  const txRef = newGatewayRef();
  const record = {
    id: null,
    user_id: req.user.userId,
    amount: fromMinor(amountMinor),
    amountMinor,
    method: 'paychangu',
    status: 'PENDING',
    provider_ref: txRef,
    gateway_ref: null,
    created_at: new Date().toISOString()
  };

  if (isSupabaseAvailable()) {
    const { data, error } = await getSupabase()
      .from('deposits')
      .insert({
        user_id: req.user.userId,
        amount: fromMinor(amountMinor),
        method: 'paychangu',
        status: 'PENDING',
        provider_ref: txRef,
        ip_address: req.ip || null
      })
      .select('id, created_at')
      .single();
    if (error) {
      await audit(req, 'DEPOSIT_INITIATE_FAILED', req.user.userId, { reason: error.message }, 'failed');
      return res.status(500).json({ status: false, message: 'Could not start the deposit' });
    }
    record.id = data.id;
    record.created_at = data.created_at || record.created_at;
  } else {
    record.id = txRef;
    memDeposits.set(txRef, record);
  }

  const method = String((req.body && (req.body.method || req.body.paymentMethod)) || '').toLowerCase();
  const payerPhone = req.body && (req.body.phoneNumber || req.body.phone);
  const wantsDirectMobileMoney = ['mpamba', 'airtel_money', 'airtel'].includes(method) && payerPhone;

  let init;
  if (wantsDirectMobileMoney) {
    init = await paychangu.initializeMobileMoney({
      amountMinor,
      txRef,
      phone: String(payerPhone),
      method,
      firstName: req.user.firstName || undefined,
      lastName: req.user.lastName || undefined,
      email: req.user.email || undefined,
      meta: {
        depositId: record.id,
        userId: req.user.userId,
        method,
        phoneNumber: typeof payerPhone === 'string' ? payerPhone.slice(0, 32) : undefined
      }
    });
  } else {
    // Return the player to a dedicated path. PayChangu appends the tx_ref to the
    // redirect URL, so keeping the base path query-free avoids malformed URLs.
    init = await paychangu.initialize({
      amountMinor,
      txRef,
      callbackUrl: `${frontendBaseUrl()}/payment/return`,
      returnUrl: `${frontendBaseUrl()}/payment/return`,
      firstName: req.user.firstName || undefined,
      lastName: req.user.lastName || undefined,
      email: req.user.email || undefined,
      meta: {
        depositId: record.id,
        userId: req.user.userId,
        method: method || 'mobile_money',
        phoneNumber: typeof payerPhone === 'string' ? payerPhone.slice(0, 32) : undefined
      }
    });
  }

  if (!init.ok) {
    await failDeposit(record, init.reason || 'gateway_error', { reference: txRef });
    const message =
      init.reason === 'not_configured'
        ? 'Card/mobile-money checkout is not configured yet'
        : init.reason === 'invalid_phone'
          ? 'Enter a valid mobile money number for the selected network.'
          : init.reason === 'operators_unavailable' || init.reason === 'operator_not_supported'
            ? 'Direct mobile money prompt is not available for the selected method right now. Please try again or contact support.'
            : init.reason === 'gateway_rejected'
              ? (init.message || 'Payment gateway could not start the payment. Please try again in a moment.')
              : 'Could not reach the payment gateway. Please check your connection and try again.';
    return res.status(init.reason === 'not_configured' ? 503 : 502).json({
      status: false,
      message,
      reason: init.reason
    });
  }

  await audit(req, 'DEPOSIT_INITIATED', req.user.userId, {
    depositId: record.id,
    amount: fromMinor(amountMinor),
    gateway: 'paychangu',
    mode: init.mode || 'checkout'
  });

  return res.json({
    status: true,
    data: {
      depositId: record.id,
      provider: 'paychangu',
      token: txRef,
      txRef,
      amount: fromMinor(amountMinor),
      checkoutUrl: init.checkoutUrl || null,
      mode: init.mode || (init.checkoutUrl ? 'checkout' : 'mobile_money'),
      message: init.message || null
    }
  });
}

// ===========================================================================
// PLAYER: wallet
// ===========================================================================

router.get('/wallet', requireAuth, async (req, res) => {
  const result = await ledger.getAvailable(req.user.userId);
  if (!result.ok) return res.status(404).json({ status: false, message: 'Account not found' });

  return res.json({
    status: true,
    data: {
      currency: 'MWK',
      balance: fromMinor(result.balance),
      held: fromMinor(result.held),
      available: fromMinor(result.available),
      limits: {
        minDeposit: fromMinor(MIN_DEPOSIT_MINOR),
        maxDeposit: fromMinor(MAX_DEPOSIT_MINOR),
        minWithdrawal: fromMinor(MIN_WITHDRAWAL_MINOR),
        maxWithdrawal: fromMinor(MAX_WITHDRAWAL_MINOR),
        withdrawalFeePercent: WITHDRAWAL_FEE_PERCENT
      }
    }
  });
});

router.get('/methods', (req, res) => {
  return res.json({
    status: true,
    data: {
      deposits: [{ id: 'mpamba', label: 'MPamba' }, { id: 'airtel_money', label: 'Airtel Money' }],
      withdrawals: payout.METHODS.map((m) => ({
        id: m,
        label: m === 'mpamba' ? 'MPamba' : 'Airtel Money'
      })),
      automaticPayout: payout.isPayoutConfigured()
    }
  });
});

/**
 * GET /config - the single, SERVER-DRIVEN source of payment display data.
 *
 * Public (no auth): exposes only public display data - supported methods, the
 * deposit/withdrawal limits, and whether the gateway is ready. No secrets.
 */
router.get('/config', (req, res) => {
  return res.json({
    status: true,
    data: {
      currency: 'MWK',
      deposit: {
        min: fromMinor(MIN_DEPOSIT_MINOR),
        max: fromMinor(MAX_DEPOSIT_MINOR),
        methods: [
          { id: 'mpamba', label: 'MPamba' },
          { id: 'airtel_money', label: 'Airtel Money' }
        ]
      },
      withdrawal: {
        min: fromMinor(MIN_WITHDRAWAL_MINOR),
        max: fromMinor(MAX_WITHDRAWAL_MINOR),
        feePercent: WITHDRAWAL_FEE_PERCENT,
        methods: payout.METHODS.map((m) => ({
          id: m,
          label: m === 'mpamba' ? 'MPamba' : 'Airtel Money'
        }))
      },
      automaticPayout: payout.isPayoutConfigured(),
      // PayChangu is the only deposit gateway. `auto` is kept for clients that
      // still read it; it is 'paychangu' when checkout is configured, else null.
      gateways: {
        paychangu: paychangu.isConfigured(),
        auto: paychangu.isConfigured() ? 'paychangu' : null
      }
    }
  });
});

/**
 * GET /statement - the player's own money history.
 *
 * Read from balance_ledger, the append-only record every movement is written
 * to in the same transaction as the movement itself. A player being able to see
 * their own statement is what makes "balance went down by 500 and I cannot see
 * why" a support question they can answer themselves instead of a trust dispute.
 */
router.get('/statement', requireAuth, async (req, res) => {
  try {
    const result = await ledger.getLedger(req.user.userId, req.query && req.query.limit);
    if (!result.ok) {
      return res.status(500).json({ status: false, message: 'Could not load your statement' });
    }

    return res.json({
      status: true,
      data: result.entries.map((e) => ({
        // The ledger stores money in MWK (NUMERIC(14,2) / fromMinor output),
        // NOT minor units, so these values are passed through, never converted.
        amount: Number(e.delta),
        heldDelta: Number(e.hold_delta || 0),
        balanceAfter: Number(e.balance_after),
        reason: e.reason,
        reference: e.ref_id ? `${e.ref_type || ''}:${e.ref_id}` : null,
        at: e.created_at
      }))
    });
  } catch (error) {
    console.error('[payments] statement error:', error);
    return res.status(500).json({ status: false, message: 'Could not load your statement' });
  }
});

// ===========================================================================
// PLAYER: deposits
// ===========================================================================

/**
 * POST /api/payments/deposits
 * Creates a PENDING deposit and returns the token the customer authorises on
 * the gateway. No money moves here — the balance is credited only when the
 * gateway callback is verified.
 */
router.post('/deposits', requireAuth, requireActivePlayer, apiRateLimit, async (req, res) => {
  try {
    const amountMinor = toMinor(req.body && req.body.amount);
    const invalid = validateAmount(amountMinor, MIN_DEPOSIT_MINOR, MAX_DEPOSIT_MINOR, 'Deposit');
    if (invalid) return res.status(400).json({ status: false, message: invalid });

    // PayChangu is the only deposit gateway. Accept 'auto' (default) or an
    // explicit 'paychangu'; anything else is rejected rather than silently
    // falling through to a provider that no longer exists.
    const requested = String((req.body && req.body.provider) || 'auto').toLowerCase();
    if (!['auto', 'paychangu'].includes(requested)) {
      return res.status(400).json({ status: false, message: 'Unsupported payment provider' });
    }

    // Fail closed BEFORE writing a PENDING row: an unconfigured deploy must not
    // leave the player with a reference no gateway can settle.
    if (!paychangu.isConfigured()) {
      return res.status(503).json({
        status: false,
        message: 'Card/mobile-money checkout is not configured yet'
      });
    }

    return startPayChanguDeposit(req, res, amountMinor);
  } catch (error) {
    console.error('[payments] deposit initiate error:', error);
    return res.status(500).json({ status: false, message: 'Could not start the deposit' });
  }
});

router.get('/deposits', requireAuth, async (req, res) => {
  try {
    let rows;
    if (isSupabaseAvailable()) {
      const { data, error } = await getSupabase()
        .from('deposits')
        .select('id, amount, method, status, provider_ref, failure_reason, created_at, completed_at')
        .eq('user_id', req.user.userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      rows = data || [];
    } else {
      rows = [...memDeposits.values()]
        .filter((d) => d.user_id === req.user.userId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 50);
    }
    return res.json({ status: true, data: rows });
  } catch (error) {
    console.error('[payments] deposit history error:', error);
    return res.status(500).json({ status: false, message: 'Could not load deposit history' });
  }
});

/**
 * GET /api/payments/deposits/:txRef/status
 *
 * Called by the browser after PayChangu redirects back (and polled while the
 * player is on the checkout page). It never trusts the redirect: it asks
 * PayChangu for the authoritative status, then credits exactly once.
 */
router.get('/deposits/:txRef/status', requireAuth, apiRateLimit, async (req, res) => {
  try {
    const txRef = String(req.params.txRef || '');
    if (!isGatewayRef(txRef)) {
      return res.status(404).json({ status: false, message: 'Unknown transaction' });
    }

    const deposit = await findPayChanguDeposit(txRef, req.user.userId);
    if (!deposit) {
      return res.status(404).json({ status: false, message: 'Unknown transaction' });
    }

    if (deposit.status !== 'PENDING') {
      return res.json({
        status: true,
        data: { status: deposit.status, credited: deposit.status === 'COMPLETED', txRef }
      });
    }

    let verification = await paychangu.verify(txRef);
    // Direct Mobile Money charges are invisible to /verify-payment (PayChangu
    // answers "Payment link not found"), so fall back to charge verification.
    if (verification.ok && verification.status === 'not_found') {
      const charge = await paychangu.verifyMobileMoney(txRef);
      if (charge.ok) verification = charge;
    }
    if (!verification.ok) {
      // Gateway unreachable: keep the deposit pending so a later poll can
      // settle it. Never mark it failed on a transport error.
      return res.status(202).json({
        status: true,
        data: { status: 'PENDING', pending: true, txRef }
      });
    }

    const result = await settlePayChanguDeposit(req, deposit, verification);
    if (result.error) {
      return res.status(500).json({ status: false, message: 'Could not credit the deposit' });
    }

    return res.json({
      status: true,
      data: {
        status: result.status,
        credited: Boolean(result.credited),
        txRef
      }
    });
  } catch (error) {
    console.error('[payments] paychangu status error:', error.message);
    return res.status(500).json({ status: false, message: 'Could not check the payment' });
  }
});

/** Atomically move PENDING -> COMPLETED. Returns false if someone else won. */
async function claimDeposit(depositId, gateway) {
  const extra = {
    status: 'COMPLETED',
    completed_at: new Date().toISOString(),
    // Record what the gateway actually said it charged, so a later dispute can
    // be reconciled against both figures instead of only our request.
    gateway_amount: gateway.amountMinor === null ? null : fromMinor(gateway.amountMinor),
    gateway_ref: gateway.ref || null
  };

  if (isSupabaseAvailable()) {
    // The conditional `.eq('status','PENDING')` is the idempotency guarantee:
    // the UPDATE takes a row lock, so only one concurrent caller sees a row
    // returned. A prior read-then-write version raced and double-credited.
    const { data, error } = await getSupabase()
      .from('deposits')
      .update(extra)
      .eq('id', depositId)
      .eq('status', 'PENDING')
      .select('id');
    if (error) {
      console.error('[payments] claim failed:', error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  }
  const record = [...memDeposits.values()].find((d) => d.id === depositId);
  if (!record || record.status !== 'PENDING') return false;
  record.status = 'COMPLETED';
  record.gateway_amount = extra.gateway_amount;
  return true;
}

/** Undo a claim so a retry can succeed (only used if the credit failed). */
async function unclaimDeposit(depositId) {
  if (isSupabaseAvailable()) {
    await getSupabase()
      .from('deposits')
      .update({ status: 'PENDING', completed_at: null, gateway_ref: null })
      .eq('id', depositId)
      .eq('status', 'COMPLETED');
    return;
  }
  const record = [...memDeposits.values()].find((d) => d.id === depositId);
  if (record) record.status = 'PENDING';
}

/** Record a failed/underpaid deposit. Money is NOT credited. */
async function failDeposit(deposit, reason, body) {
  // Never overwrite a deposit that another concurrent path (the status poll)
  // has already settled. The Postgres update is conditional; memory mode must be
  // too, or a late capture failure could relabel a credited deposit as FAILED.
  if (deposit.status !== 'PENDING') return;

  if (isSupabaseAvailable()) {
    await getSupabase()
      .from('deposits')
      .update({ status: 'FAILED', failure_reason: reason, gateway_ref: body.reference || null })
      .eq('id', deposit.id)
      .eq('status', 'PENDING');
  } else {
    deposit.status = 'FAILED';
    deposit.failure_reason = reason;
  }
  await audit(
    { ip: null },
    'DEPOSIT_FAILED',
    deposit.user_id,
    { depositId: deposit.id, reason, notificationCode: body.notification_code },
    'failed'
  );
}

// ===========================================================================
// PLAYER: withdrawals
// ===========================================================================

/**
 * POST /api/payments/withdrawals
 *
 * SECURITY FIX (was High H-2 class): the old endpoint took `phoneNumber` from
 * the REQUEST BODY, so a logged-in player could direct their own winnings to
 * ANY phone number — including an accomplice's — which is the standard pattern
 * for laundering stolen funds through a compromised account. The destination is
 * now taken from the player's REGISTERED payout_phone only.
 *
 * Funds are HELD immediately (debited from balance into `held`) so the same
 * money cannot be spent on bets while the withdrawal is pending.
 */
router.post(
  '/withdrawals',
  requireAuth,
  requireActivePlayer,
  credentialLimiter(15 * 60_000, 5),
  async (req, res) => {
  try {
    const amountMinor = toMinor(req.body && req.body.amount);
    const invalid = validateAmount(
      amountMinor,
      MIN_WITHDRAWAL_MINOR,
      MAX_WITHDRAWAL_MINOR,
      'Withdrawal'
    );
    if (invalid) return res.status(400).json({ status: false, message: invalid });

    const method = req.body && req.body.method;
    const requestedPhone = req.body && req.body.phoneNumber;

    const account = await loadAccount(req.user.userId);
    if (!account) return res.status(404).json({ status: false, message: 'Account not found' });

    // Quick-play credit is a demo stake, not customer money. It unlocks as soon
    // as a real deposit completes (clearGuestFlag in settlePayChanguDeposit).
    if (account.is_guest) {
      await audit(req, 'WITHDRAWAL_GUEST_BLOCKED', req.user.userId, {
        reason: 'quick-play account has no completed deposit'
      }, 'failed');
      return res.status(403).json({
        status: false,
        message: 'Make a deposit first to unlock withdrawals.'
      });
    }

    // Destination must be the REGISTERED wallet, and the client may only ever
    // echo it back — never introduce a new one.
    const registered = account.payout_phone;
    if (!registered) {
      return res.status(400).json({
        status: false,
        message: 'Add a verified payout phone number to your profile before withdrawing'
      });
    }
    if (requestedPhone && String(requestedPhone).replace(/\D/g, '') !== String(registered).replace(/\D/g, '')) {
      await audit(req, 'WITHDRAWAL_DESTINATION_MISMATCH', req.user.userId, {
        reason: 'client supplied a destination that is not the registered wallet'
      }, 'failed');
      return res.status(400).json({
        status: false,
        message: 'Withdrawals can only be sent to your registered phone number'
      });
    }

    const destination = payout.validateDestination(registered, method);
    if (!destination.ok) {
      return res.status(400).json({ status: false, message: destination.reason });
    }

    // 1. HOLD the funds first: money leaves `balance` and enters `held`, so it
    //    becomes unspendable in the same statement.
    //    Ordered hold -> insert so a crash cannot leave a hold with no record.
    const hold = await ledger.placeHold({
      userId: req.user.userId,
      amountMinor,
      refType: 'withdrawal',
      metadata: { method }
    });
    if (!hold.ok) {
      return res.status(400).json({
        status: false,
        message: hold.reason === 'Insufficient balance' ? 'Insufficient balance' : 'Could not process the withdrawal'
      });
    }

    const feeMinor = feeFromMinor(amountMinor, WITHDRAWAL_FEE_PERCENT);
    const record = {
      id: null,
      user_id: req.user.userId,
      amount: fromMinor(amountMinor),
      amountMinor,
      fee: fromMinor(feeMinor),
      net_amount: fromMinor(amountMinor - feeMinor),
      method,
      phone_number: destination.normalised,
      status: 'PENDING',
      created_at: new Date().toISOString()
    };

    if (isSupabaseAvailable()) {
      // withdrawals.id is a UUID default. Do not send our own text id.
      const { data, error } = await getSupabase()
        .from('withdrawals')
        .insert({
          user_id: req.user.userId,
          amount: fromMinor(amountMinor),
          fee: fromMinor(feeMinor),
          net_amount: fromMinor(amountMinor - feeMinor),
          method,
          phone_number: destination.normalised,
          status: 'PENDING',
          ip_address: req.ip || null
        })
        .select('id, created_at')
        .single();
      if (error) {
        // Refund the hold so the player is not charged for our failure.
        await refundHold(req.user.userId, amountMinor, null, 'withdrawal insert failed');
        return res.status(500).json({ status: false, message: 'Could not process the withdrawal' });
      }
      record.id = data.id;
      record.created_at = data.created_at || record.created_at;
    } else {
      record.id = newId('wd');
      memWithdrawals.set(record.id, record);
    }

    await audit(req, 'WITHDRAWAL_REQUESTED', req.user.userId, {
      withdrawalId: record.id,
      amount: fromMinor(amountMinor),
      net: fromMinor(amountMinor - feeMinor)
    });

    return res.json({
      status: true,
      data: {
        id: record.id,
        amount: record.amount,
        fee: record.fee,
        netAmount: record.net_amount,
        status: 'PENDING',
        phoneNumber: destination.normalised,
        message: 'Withdrawal requested. Funds are held until an operator approves it.'
      }
    });
  } catch (error) {
    console.error('[payments] withdrawal request error:', error);
    return res.status(500).json({ status: false, message: 'Could not process the withdrawal' });
  }
});

router.get('/withdrawals', requireAuth, async (req, res) => {
  try {
    let rows;
    if (isSupabaseAvailable()) {
      const { data, error } = await getSupabase()
        .from('withdrawals')
        .select('id, amount, fee, net_amount, method, phone_number, status, rejection_reason, created_at, processed_at')
        .eq('user_id', req.user.userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      rows = data || [];
    } else {
      rows = [...memWithdrawals.values()]
        .filter((w) => w.user_id === req.user.userId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 50);
    }
    return res.json({ status: true, data: rows });
  } catch (error) {
    console.error('[payments] withdrawal history error:', error);
    return res.status(500).json({ status: false, message: 'Could not load withdrawal history' });
  }
});

/** Player cancels a PENDING withdrawal; the hold is refunded atomically. */
router.post('/withdrawals/:id/cancel', requireAuth, requireActivePlayer, async (req, res) => {
  try {
    const record = await loadWithdrawal(req.params.id);
    if (!record || record.user_id !== req.user.userId) {
      return res.status(404).json({ status: false, message: 'Withdrawal not found' });
    }
    if (record.status !== 'PENDING') {
      return res.status(400).json({ status: false, message: 'Only a pending withdrawal can be cancelled' });
    }

    const transitioned = await transitionWithdrawal(record.id, 'CANCELLED', {
      processed_by: req.user.userId,
      rejection_reason: 'Cancelled by player'
    });
    if (!transitioned) {
      return res.status(400).json({ status: false, message: 'Withdrawal is no longer pending' });
    }

    await refundHold(record.user_id, toMinor(record.amount), record.id, 'player cancelled');
    await audit(req, 'WITHDRAWAL_CANCELLED', record.user_id, { withdrawalId: record.id });

    return res.json({ status: true, message: 'Withdrawal cancelled and the funds released' });
  } catch (error) {
    console.error('[payments] cancel error:', error);
    return res.status(500).json({ status: false, message: 'Could not cancel the withdrawal' });
  }
});

// ===========================================================================
// ADMIN
// ===========================================================================

router.get('/admin/withdrawals', requireAdmin, async (req, res) => {
  try {
    const statusFilter = req.query && req.query.status;
    const selectCols =
      'id, user_id, amount, fee, net_amount, method, phone_number, status, rejection_reason, created_at, processed_at, processed_by';

    let rows;
    if (isSupabaseAvailable()) {
      let query = getSupabase().from('withdrawals').select(selectCols);
      if (statusFilter) query = query.eq('status', statusFilter);
      const { data, error } = await query.order('created_at', { ascending: true }).limit(200);
      if (error) throw error;
      rows = data || [];
    } else {
      rows = [...memWithdrawals.values()]
        .filter((w) => (statusFilter ? w.status === statusFilter : true))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, 200);
    }
    return res.json({ status: true, data: rows });
  } catch (error) {
    console.error('[payments] admin queue error:', error);
    return res.status(500).json({ status: false, message: 'Could not load the withdrawal queue' });
  }
});

/**
 * GET /api/payments/admin/deposits - recent deposits for reconciliation.
 * Optional ?status=PENDING|COMPLETED|FAILED|EXPIRED filter.
 */
router.get('/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const statusFilter = req.query && req.query.status;
    const selectCols =
      'id, user_id, amount, method, status, failure_reason, provider_ref, created_at, completed_at';

    let rows;
    if (isSupabaseAvailable()) {
      let query = getSupabase().from('deposits').select(selectCols);
      if (statusFilter) query = query.eq('status', statusFilter);
      const { data, error } = await query.order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      rows = data || [];
    } else {
      rows = [...memDeposits.values()]
        .filter((d) => (statusFilter ? d.status === statusFilter : true))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 200);
    }
    return res.json({ status: true, data: rows });
  } catch (error) {
    console.error('[payments] admin deposits error:', error);
    return res.status(500).json({ status: false, message: 'Could not load deposits' });
  }
});

/**
 * POST /api/payments/admin/withdrawals/:id/approve
 *
 * The payout is attempted BEFORE the state changes to PAID. If the gateway
 * does not positively confirm, the withdrawal stays PENDING and the operator is
 * told why. Optimistically marking it PAID would risk paying twice.
 *
 * No payout API is wired up (PayChangu checkout is deposits-only), so approval
 * falls back to an explicit MANUAL settlement: the operator sends the money from
 * the PayChangu dashboard and confirms with `{ manual: true, reference }`.
 * The explicit flag is required so a single click can never mark an unsent
 * payout as PAID.
 */
router.post('/admin/withdrawals/:id/approve', requireAdmin, async (req, res) => {
  try {
    const record = await loadWithdrawal(req.params.id);
    if (!record) return res.status(404).json({ status: false, message: 'Withdrawal not found' });
    if (record.status !== 'PENDING') {
      return res.status(400).json({ status: false, message: 'Only a pending withdrawal can be approved' });
    }

    const body = req.body || {};
    const netMinor = toMinor(record.net_amount);
    let gatewayRef = null;

    if (payout.isPayoutConfigured()) {
      const send = await payout.sendToWallet({
        amountMinor: netMinor,
        phoneNumber: record.phone_number,
        method: record.method,
        reference: record.id
      });

      if (!send.ok) {
        await audit(req, 'WITHDRAWAL_APPROVE_FAILED', record.user_id, {
          withdrawalId: record.id,
          reason: send.reason,
          code: send.code
        }, 'failed', req.admin && req.admin.username);
        return res.status(503).json({
          status: false,
          message: send.reason,
          code: send.code,
          fundsStillHeld: true
        });
      }
      gatewayRef = send.gatewayRef || null;
    } else {
      // Manual settlement: the operator has already sent the money out of band.
      if (body.manual !== true) {
        return res.status(409).json({
          status: false,
          message:
            'Automatic payout is not configured. Send the money from the PayChangu ' +
            'dashboard, then approve with manual:true and the payout reference.',
          code: payout.NOT_CONFIGURED,
          fundsStillHeld: true
        });
      }
      const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
      if (!reference) {
        return res.status(400).json({
          status: false,
          message: 'A payout reference is required for manual settlement',
          fundsStillHeld: true
        });
      }
      gatewayRef = reference.slice(0, 200);
      await audit(req, 'WITHDRAWAL_MANUAL_SETTLEMENT', record.user_id, {
        withdrawalId: record.id,
        reference: gatewayRef
      }, 'success', req.admin && req.admin.username);
    }

    const transitioned = await transitionWithdrawal(record.id, 'PAID', {
      processed_by: (req.admin && req.admin.username) || 'admin',
      gateway_ref: gatewayRef
    });
    if (!transitioned) {
      return res.status(400).json({ status: false, message: 'Withdrawal is no longer pending' });
    }

    // The money already left `balance` when the hold was placed, so this only
    // consumes `held`. Without this step `held` stays inflated forever and the
    // escrow total can never be reconciled against pending withdrawals.
    await settleHold(record.user_id, toMinor(record.amount), record.id, 'payout confirmed');

    await audit(req, 'WITHDRAWAL_PAID', record.user_id, {
      withdrawalId: record.id,
      net: Number(record.net_amount),
      gatewayRef
    }, 'success', req.admin && req.admin.username);

    return res.json({ status: true, message: 'Payout recorded', gatewayRef });
  } catch (error) {
    console.error('[payments] approve error:', error);
    return res.status(500).json({ status: false, message: 'Could not approve the withdrawal' });
  }
});

router.post('/admin/withdrawals/:id/reject', requireAdmin, async (req, res) => {
  try {
    const reason = req.body && req.body.reason;
    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ status: false, message: 'A rejection reason is required' });
    }
    const record = await loadWithdrawal(req.params.id);
    if (!record) return res.status(404).json({ status: false, message: 'Withdrawal not found' });
    if (record.status !== 'PENDING') {
      return res.status(400).json({ status: false, message: 'Only a pending withdrawal can be rejected' });
    }

    const transitioned = await transitionWithdrawal(record.id, 'REJECTED', {
      processed_by: (req.admin && req.admin.username) || 'admin',
      rejection_reason: reason.trim().slice(0, 500)
    });
    if (!transitioned) {
      return res.status(400).json({ status: false, message: 'Withdrawal is no longer pending' });
    }

    await refundHold(record.user_id, toMinor(record.amount), record.id, 'withdrawal rejected');
    await audit(req, 'WITHDRAWAL_REJECTED', record.user_id, {
      withdrawalId: record.id,
      reason: reason.trim()
    }, 'success', req.admin && req.admin.username);

    return res.json({ status: true, message: 'Withdrawal rejected and the funds returned' });
  } catch (error) {
    console.error('[payments] reject error:', error);
    return res.status(500).json({ status: false, message: 'Could not reject the withdrawal' });
  }
});

/** Manual balance adjustment. Every one is attributed and audited. */
router.post('/admin/credits', requireAdmin, credentialLimiter(60_000, 30), async (req, res) => {
  try {
    const userId = req.body && req.body.userId;
    const amountMinor = toMinor(req.body && req.body.amount);
    const reason = req.body && req.body.reason;

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ status: false, message: 'A userId is required' });
    }
    if (!Number.isInteger(amountMinor) || amountMinor === 0) {
      return res.status(400).json({ status: false, message: 'A non-zero amount is required' });
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ status: false, message: 'A reason is required for every adjustment' });
    }

    const result = await ledger.moveBalance({
      userId,
      amountMinor,
      reason: amountMinor > 0 ? ledger.REASONS.ADMIN_CREDIT : ledger.REASONS.ADMIN_DEBIT,
      refType: 'admin',
      refId: (req.admin && req.admin.username) || 'admin',
      metadata: { reason: reason.trim().slice(0, 500) }
    });

    if (!result.ok) {
      await audit(req, 'ADMIN_ADJUSTMENT_FAILED', userId, { reason: result.reason }, 'failed',
        req.admin && req.admin.username);
      return res.status(400).json({ status: false, message: result.reason });
    }

    await audit(req, 'ADMIN_ADJUSTMENT', userId, {
      amount: fromMinor(amountMinor),
      reason: reason.trim().slice(0, 500),
      newBalance: fromMinor(result.balance)
    }, 'success', req.admin && req.admin.username);

    return res.json({
      status: true,
      data: { balance: fromMinor(result.balance) },
      message: `Adjusted ${amountMinor > 0 ? '+' : ''}${formatMinor(amountMinor)}`
    });
  } catch (error) {
    console.error('[payments] admin credit error:', error);
    return res.status(500).json({ status: false, message: 'Could not apply the adjustment' });
  }
});

// ===========================================================================
// Helpers
// ===========================================================================

/** Read a user's money columns and registered payout phone. Never the password. */
async function loadAccount(userId) {
  if (isSupabaseAvailable()) {
    const { data, error } = await getSupabase()
      .from('users')
      .select('id, balance, held, payout_phone, is_banned, is_guest')
      .eq('id', userId)
      .single();
    if (error || !data) return null;
    if (data.is_banned) return { ...data, banned: true };
    return data;
  }
  const user = memoryStore.findUserById(userId);
  if (!user) return null;
  return {
    id: user.id,
    balance: user.balance,
    held: 0,
    payout_phone: user.payout_phone || user.phone_number,
    is_banned: Boolean(user.is_banned),
    is_guest: Boolean(user.is_guest)
  };
}

async function loadWithdrawal(id) {
  if (typeof id !== 'string' || !id) return null;
  if (isSupabaseAvailable()) {
    const { data, error } = await getSupabase().from('withdrawals').select('*').eq('id', id).maybeSingle();
    if (error) return null;
    return data || null;
  }
  return memWithdrawals.get(id) || null;
}

/** Atomic state change, conditional on the row still being PENDING. */
async function transitionWithdrawal(id, nextStatus, fields) {
  if (isSupabaseAvailable()) {
    const { data, error } = await getSupabase()
      .from('withdrawals')
      .update({
        status: nextStatus,
        processed_by: fields.processed_by || null,
        processed_at: new Date().toISOString(),
        rejection_reason: fields.rejection_reason || null,
        gateway_ref: fields.gateway_ref || null
      })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id');
    if (error) {
      console.error('[payments] transition failed:', error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  }
  const record = memWithdrawals.get(id);
  if (!record || record.status !== 'PENDING') return false;
  record.status = nextStatus;
  Object.assign(record, fields, { processed_at: new Date().toISOString() });
  return true;
}

/**
 * Return held funds after a withdrawal is cancelled or rejected.
 *
 * Delegates to ledger.refundHold(), which moves X out of `held` AND into
 * `balance` in one statement. An earlier version credited the balance and left
 * `held` alone, which made the escrow counter permanently overstate how much
 * was outstanding after the first refund.
 */
async function refundHold(userId, amountMinor, withdrawalId, why) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return { ok: false };
  return ledger.refundHold({
    userId,
    amountMinor,
    refType: 'withdrawal',
    refId: withdrawalId,
    metadata: { why }
  });
}

/**
 * Consume the escrow once the gateway has confirmed the payout.
 * balance is untouched; only `held` is decremented (see ledger.releaseHold).
 */
async function settleHold(userId, amountMinor, withdrawalId, why) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return { ok: false };
  return ledger.releaseHold({
    userId,
    amountMinor,
    refType: 'withdrawal',
    refId: withdrawalId,
    metadata: { why }
  });
}

module.exports = router;