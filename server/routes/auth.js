/**
 * Authentication routes.
 *
 * SECURITY CHANGES (see SECURITY_REPORT.md for detail):
 *  - Balance-mutating endpoints (/deposit, /withdraw, /update-balance) now
 *    require an ADMIN token. They previously accepted an unauthenticated
 *    POST body of { phoneNumber, amount } from anyone, which allowed unlimited
 *    free balance minting (CWE-306 Missing Authentication, Critical).
 *  - /user-info now requires authentication and only ever returns the
 *    caller's own record (was an unauthenticated username oracle).
 *  - Login/register/quick-play are rate limited against credential stuffing.
 *  - Internal error strings are no longer echoed to clients (CWE-209).
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { getSupabase, isSupabaseAvailable } = require('../config/supabase');
const memoryStore = require('../config/memoryStore');
const { signUserToken } = require('../config/auth');
const { requireAuth, requireAdmin, credentialLimiter, apiRateLimit } = require('../middleware/auth');
const ledger = require('../services/ledger');
const { validateDestination } = require('../services/payout');
const { writeAuditLog } = require('../services/audit');
const {
  normalisePhone,
  phoneLookupKeys,
  isValidPhone,
  duplicateField
} = require('../services/phone');
const { toMinor, fromMinor } = require('../config/money');

const router = express.Router();

/** Build a rate limiter that returns a stable JSON body. */
function rateLimitFactory(windowMs, max) {
  const { rateLimit } = require('express-rate-limit');
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({
        status: false,
        message: 'Too many attempts. Please wait before trying again.'
      })
  });
}

// 10 attempts / 15 min per (IP + identifier).
const registerLimiter = credentialLimiter(15 * 60_000, 10);
const loginLimiter = credentialLimiter(15 * 60_000, 10);
// Guest accounts are a balance-farming vector, so cap them hard per IP.
const quickPlayLimiter = rateLimitFactory(60 * 60_000, 3);

/** Log the real reason server-side, return a generic message to the client. */
function fail(res, status, clientMessage, internalError, context) {
  if (internalError) {
    console.error(`[auth] ${context}:`, internalError);
  }
  return res.status(status).json({ status: false, message: clientMessage });
}

// ============================================
// VALIDATION HELPERS
// ============================================

const USERNAME_RE = /^[a-zA-Z0-9]{3,20}$/;

/**
 * Validate and normalise a phone number. Accepts the forms players actually
 * type (local 9/10-digit, 265..., +265...) and reduces them to one canonical
 * value, so one subscriber cannot own several accounts.
 */
function validatePhone(value) {
  return isValidPhone(value);
}

/**
 * Validate a password. Minimum 8 chars and at least one letter plus one
 * number - rejects the trivial passwords the old 6-char rule allowed.
 */
function validatePassword(value) {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 128 &&
    /[a-zA-Z]/.test(value) &&
    /[0-9]/.test(value)
  );
}

/** Normalise and clamp an amount; returns null when unusable. */
function sanitizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return null;
  return Math.round(amount * 100) / 100;
}

const defaultPanel = () => ({
  auto: false,
  autocashout: false,
  betid: '0',
  betted: false,
  cashouted: false,
  cashAmount: 0,
  betAmount: 20,
  target: 2
});

/** Public projection of a user row - never includes the password hash. */
function publicUser(user) {
  return {
    userId: user.id,
    userName: user.user_name,
    phoneNumber: user.phone_number,
    // The player's own registered payout wallet. Safe to expose to the owner;
    // this projection is only ever reached for the authenticated caller (the
    // legacy /user-info route is scoped to req.user.userId).
    payoutPhone: user.payout_phone || null,
    balance: Number(user.balance) || 0,
    avatar: user.avatar || '',
    currency: user.currency || 'MWK',
    userType: Boolean(user.user_type),
    // Lets the wallet UI explain why withdrawals are locked on a quick-play
    // account instead of showing a generic rejection.
    isGuest: Boolean(user.is_guest),
    isSoundEnable: user.is_sound_enable,
    isMusicEnable: user.is_music_enable,
    // Owner-only projection, so exposing the account creation date is safe and
    // lets the profile show a "member since" line.
    createdAt: user.created_at || null,
    f: defaultPanel(),
    s: defaultPanel()
  };
}

/** Generate a random username for guest accounts. */
function generateRandomUsername() {
  const adjectives = ['Happy', 'Lucky', 'Swift', 'Brave', 'Clever', 'Eager', 'Fancy', 'Gentle'];
  const nouns = ['Panda', 'Tiger', 'Eagle', 'Wolf', 'Fox', 'Bear', 'Lion', 'Hawk'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}${noun}${Math.floor(Math.random() * 10000)}`;
}

function generateSyntheticPhone() {
  let phone = '';
  for (let i = 0; i < 13; i++) phone += Math.floor(Math.random() * 10);
  return phone;
}

/**
 * True when a user with this phone already exists.
 *
 * Checks every common stored representation, not just the canonical one, so a
 * legacy `0991234567` row still blocks a new `+265991234567` signup.
 */
async function phoneExists(phoneNumber) {
  const keys = phoneLookupKeys(phoneNumber);
  if (keys.length === 0) return false;

  if (!isSupabaseAvailable()) {
    return keys.some((key) => Boolean(memoryStore.findUserByPhone(key)));
  }

  const supabase = getSupabase();
  const { data } = await supabase
    .from('users')
    .select('id')
    .in('phone_number', keys)
    .limit(1);
  return Boolean(data && data.length);
}

/**
 * Find an account by any accepted phone-number representation.
 * @returns {Promise<object|null>}
 */
async function findUserByPhone(phoneNumber) {
  const keys = phoneLookupKeys(phoneNumber);
  if (keys.length === 0) return null;

  if (!isSupabaseAvailable()) {
    for (const key of keys) {
      const user = memoryStore.findUserByPhone(key);
      if (user) return user;
    }
    return null;
  }

  const supabase = getSupabase();
  const { data } = await supabase
    .from('users')
    .select('*')
    .in('phone_number', keys)
    .limit(1);
  return data && data.length ? data[0] : null;
}

/** True when a user with this name already exists. */
async function usernameExists(userName) {
  if (!isSupabaseAvailable()) return Boolean(memoryStore.findUserByName(userName));
  const supabase = getSupabase();
  const { data } = await supabase.from('users').select('id').eq('user_name', userName).limit(1);
  return Boolean(data && data.length);
}

// ============================================
// REGISTER
// ============================================

router.post('/register', registerLimiter, apiRateLimit, async (req, res) => {
  const { phoneNumber, userName, password, email } = req.body || {};

  if (!validatePhone(phoneNumber)) {
    return fail(res, 400, 'Enter a valid phone number (9-15 digits)', null, 'register/phone');
  }
  if (typeof userName !== 'string' || !USERNAME_RE.test(userName)) {
    return fail(res, 400, 'Username must be 3-20 letters or numbers', null, 'register/username');
  }
  if (!validatePassword(password)) {
    return fail(
      res,
      400,
      'Password must be at least 8 characters and include a letter and a number',
      null,
      'register/password'
    );
  }
  if (email !== undefined && email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email))) {
    return fail(res, 400, 'Enter a valid email address', null, 'register/email');
  }

  // Store one canonical representation. This is what makes the database's
  // UNIQUE(phone_number) constraint block the same subscriber signing up twice.
  const phone = normalisePhone(phoneNumber);
  const name = String(userName);

  try {
    if (await phoneExists(phone)) {
      return fail(res, 409, 'Phone number already registered. Please login.', null, 'register/phone-dupe');
    }
    if (await usernameExists(name)) {
      return fail(res, 409, 'Username already exists', null, 'register/name-dupe');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    let newUser;
    if (!isSupabaseAvailable()) {
      newUser = memoryStore.createUser({
        phone_number: phone,
        user_name: name,
        password: passwordHash,
        email: email || '',
        balance: 0
      });
    } else {
      const supabase = getSupabase();
      const { data: created, error } = await supabase
        .from('users')
        .insert([
          {
            phone_number: phone,
            user_name: name,
            password: passwordHash,
            email: email || '',
            balance: 0,
            currency: 'MWK'
          }
        ])
        .select()
        .single();
      if (error) throw error;
      newUser = created;
    }

    const token = signUserToken(newUser);
    console.log(`[auth] Registered user ${newUser.user_name}`);

    res.json({
      status: true,
      message: 'Registration successful',
      token,
      user: publicUser(newUser)
    });
  } catch (error) {
    // The SELECT-then-INSERT check above is racy under concurrent signups.
    // The unique index is the real guarantee; translate its violation into the
    // same 409 a player would have received from the pre-check.
    const dupe = duplicateField(error);
    if (dupe === 'phone') {
      return fail(res, 409, 'Phone number already registered. Please login.', null, 'register/phone-dupe');
    }
    if (dupe === 'name') {
      return fail(res, 409, 'Username already exists', null, 'register/name-dupe');
    }
    if (dupe) {
      return fail(
        res,
        409,
        'Phone number or username already registered.',
        null,
        'register/dupe'
      );
    }
    return fail(res, 500, 'Registration failed. Please try again.', error, 'register');
  }
});

// ============================================
// LOGIN
// ============================================

router.post('/login', loginLimiter, apiRateLimit, async (req, res) => {
  const { phoneNumber, password } = req.body || {};

  if (!validatePhone(phoneNumber) || typeof password !== 'string' || password.length === 0) {
    // Same message for both cases so the endpoint is not a user oracle.
    return fail(res, 401, 'Invalid phone number or password', null, 'login/input');
  }

  const phone = normalisePhone(phoneNumber);

  try {
    // Look up every legacy format as well as the canonical one, so an account
    // registered before normalisation can still log in normally.
    const user = await findUserByPhone(phone);

    // Always run a bcrypt comparison so a missing account and a wrong password
    // take a comparable amount of time (defeats user enumeration by timing).
    const hash = (user && user.password) || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const isMatch = await bcrypt.compare(password, hash);

    if (!user || !isMatch) {
      return fail(res, 401, 'Invalid phone number or password', null, 'login/creds');
    }

    // Suspended accounts cannot sign in. Checked after the password comparison
    // so a banned user and a wrong password still take comparable time, and the
    // message never reveals whether the password was correct.
    if (user.is_banned) {
      writeAuditLog({
        action: 'USER_LOGIN',
        actor: user.user_name,
        status: 'failed',
        ip: req.ip,
        details: { reason: 'banned' }
      }).catch(() => {});
      return res.status(403).json({
        status: false,
        message: 'This account has been suspended. Please contact support.'
      });
    }

    // Remember the successful sign-in. Best effort: a failure here must never
    // block an otherwise valid login.
    try {
      if (!isSupabaseAvailable()) {
        memoryStore.touchLogin(user.id, req.ip);
      } else {
        const supabase = getSupabase();
        await supabase
          .from('users')
          .update({ last_login_at: new Date().toISOString() })
          .eq('id', user.id);
      }
    } catch (error) {
      console.error('[auth] could not record last login:', error.message);
    }

    const token = signUserToken(user);
    res.json({
      status: true,
      message: 'Login successful',
      token,
      user: publicUser(user)
    });
  } catch (error) {
    return fail(res, 500, 'Login failed. Please try again.', error, 'login');
  }
});

// ============================================
// QUICK PLAY (guest account)
// ============================================

/**
 * Creates a throwaway guest account so casual players can try the games
 * without registering. Heavily rate limited per IP because, combined with the
 * signup bonus, an unlimited number of free accounts is a balance-farming
 * vector.
 */
router.post('/quick-play', quickPlayLimiter, apiRateLimit, async (req, res) => {
  try {
    const passwordHash = await bcrypt.hash('quickplay', 12);

    let newUser;
    if (!isSupabaseAvailable()) {
      let candidate = generateRandomUsername();
      let guard = 0;
      while (memoryStore.findUserByName(candidate) && guard++ < 50) {
        candidate = generateRandomUsername();
      }
      newUser = memoryStore.createUser({
        phone_number: '',
        user_name: candidate,
        password: passwordHash,
        email: '',
        // Opening balance is issued through the ledger below, never written
        // directly: a balance with no explaining ledger row cannot be
        // reconciled.
        balance: 0,
        is_guest: true
      });
    } else {
      const supabase = getSupabase();
      let phone = generateSyntheticPhone();
      let guard = 0;
      while ((await phoneExists(phone)) && guard++ < 20) phone = generateSyntheticPhone();

      let name = generateRandomUsername();
      guard = 0;
      while ((await usernameExists(name)) && guard++ < 20) name = generateRandomUsername();

      const { data: created, error } = await supabase
        .from('users')
        .insert([
          {
            user_name: name,
            password: passwordHash,
            email: '',
            // Credited through the ledger after insert (see below).
            balance: 0,
            phone_number: phone,
            currency: 'MWK',
            // Quick-play credit is demo money: withdrawals stay locked until a
            // real deposit completes (routes/payments.js clearGuestFlag).
            is_guest: true
          }
        ])
        .select()
        .single();
      if (error) throw error;
      newUser = created;
    }

    // Issue the demo stake as a real ledger movement. This is what lets
    // scripts/reconcile.js prove that every balance is explained by the ledger.
    const opening = await ledger.credit({
      userId: newUser.id,
      amountMinor: toMinor(1000),
      reason: ledger.REASONS.BONUS,
      refType: 'bonus',
      metadata: { source: 'quick-play' }
    });
    if (!opening.ok) {
      throw new Error(`quick-play opening credit failed: ${opening.reason}`);
    }
    newUser.balance = fromMinor(opening.balance);

    res.json({
      status: true,
      message: 'Quick play started',
      token: signUserToken(newUser),
      user: publicUser(newUser)
    });
  } catch (error) {
    return fail(res, 500, 'Quick play failed. Please try again.', error, 'quick-play');
  }
});

// ============================================
// CURRENT USER
// ============================================

/**
 * GET /me - the caller's own profile and balance.
 * Replaces the old unauthenticated /user-info username lookup.
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    let user;
    if (!isSupabaseAvailable()) {
      user = memoryStore.findUserById(req.user.userId);
    } else {
      const supabase = getSupabase();
      const { data } = await supabase.from('users').select('*').eq('id', req.user.userId).limit(1);
      user = data && data.length ? data[0] : null;
    }
    if (!user) return fail(res, 404, 'Account not found', null, 'me');

    res.json({ status: true, data: publicUser(user) });
  } catch (error) {
    return fail(res, 500, 'Could not load your account', error, 'me');
  }
});

/**
 * Legacy alias kept for the existing client, now scoped to the caller so it
 * can no longer be used to enumerate other players' balances.
 */
router.post('/user-info', requireAuth, async (req, res) => {
  try {
    const { userName } = req.body || {};
    // Allow a lookup by name only if it is the caller's own name.
    if (userName && userName !== req.user.userName) {
      return fail(res, 403, 'Not allowed', null, 'user-info/cross-user');
    }

    let user;
    if (!isSupabaseAvailable()) {
      user = memoryStore.findUserById(req.user.userId);
    } else {
      const supabase = getSupabase();
      const { data } = await supabase.from('users').select('*').eq('id', req.user.userId).limit(1);
      user = data && data.length ? data[0] : null;
    }
    if (!user) return fail(res, 404, 'Account not found', null, 'user-info');

    res.json({ status: true, data: publicUser(user) });
  } catch (error) {
    return fail(res, 500, 'Could not load your account', error, 'user-info');
  }
});

// ============================================
// PROFILE PREFERENCES
// ============================================

/**
 * PATCH /me - update a narrow allow-list of preferences.
 * The previous version accepted an arbitrary userId in the body, which is an
 * IDOR allowing any caller to rewrite another user's settings (CWE-639).
 *
 * Only keys explicitly listed below are ever written. Nothing else from the
 * body reaches the database, so this can never become a mass-assignment
 * primitive for `balance`, `is_admin` or `password` (CWE-915).
 */
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};

    if (typeof body.isSoundEnable === 'boolean') patch.is_sound_enable = body.isSoundEnable;
    if (typeof body.isMusicEnable === 'boolean') patch.is_music_enable = body.isMusicEnable;
    if (typeof body.avatar === 'string' && body.avatar.length <= 300) patch.avatar = body.avatar;

    // Registered payout wallet. This is the ONLY thing a withdrawal can pay out
    // to, so it is validated as a real Malawi mobile number before being stored
    // rather than at withdrawal time.
    if (body.payoutPhone !== undefined) {
      if (body.payoutPhone === null || body.payoutPhone === '') {
        patch.payout_phone = null;
      } else {
        const check = validateDestination(body.payoutPhone, 'mpamba');
        if (!check.ok) return fail(res, 400, check.reason, null, 'patch-me/payoutPhone');
        patch.payout_phone = check.normalised;
      }
    }

    if (Object.keys(patch).length === 0) {
      return fail(res, 400, 'Nothing to update', null, 'patch-me/empty');
    }

    if (!isSupabaseAvailable()) {
      const user = memoryStore.findUserById(req.user.userId);
      if (!user) return fail(res, 404, 'Account not found', null, 'patch-me');
      Object.assign(user, patch);
    } else {
      const supabase = getSupabase();
      const { error } = await supabase.from('users').update(patch).eq('id', req.user.userId);
      if (error) throw error;
    }

    // A payout-wallet change is security-relevant: it determines where future
    // withdrawals are sent. Log the event (never the number itself) so an
    // operator investigating a stolen-session payout can see when it changed.
    if (patch.payout_phone !== undefined) {
      await writeAuditLog({
        action: patch.payout_phone ? 'PAYOUT_PHONE_SET' : 'PAYOUT_PHONE_CLEARED',
        userId: req.user.userId,
        details: {},
        status: 'success',
        ip: req.ip || null
      });
    }

    res.json({
      status: true,
      message: 'Preferences updated',
      data: { payoutPhone: patch.payout_phone !== undefined ? patch.payout_phone : undefined }
    });
  } catch (error) {
    return fail(res, 500, 'Could not update preferences', error, 'patch-me');
  }
});

// ============================================
// OPERATOR BALANCE TOOLS  (ADMIN ONLY)
// ============================================
//
// These were the single most dangerous endpoints in the codebase: fully
// unauthenticated, they let anybody mint or burn balance for any phone number.
// They are retained as operator tools but now require an admin JWT, and each
// movement is written to the audit trail.

/**
 * Credit or debit an account by phone number.
 *
 * SECURITY: the original version read the balance, computed the new value in
 * JavaScript, and wrote it back — a read-modify-write with no atomicity (CWE-362).
 * Two concurrent operator adjustments could both read the same starting balance
 * and the second write would silently discard the first. All three operator
 * tools now delegate to services/ledger.js, which performs the conditional
 * single-statement update and writes a ledger row in the same transaction.
 */
router.post('/update-balance', requireAdmin, async (req, res) => {
  const { phoneNumber, amount, type } = req.body || {};

  if (!validatePhone(phoneNumber)) {
    return fail(res, 400, 'Valid phone number is required', null, 'update-balance/phone');
  }
  const valueMinor = toMinor(amount);
  if (valueMinor === null || valueMinor === 0) {
    return fail(res, 400, 'Invalid amount', null, 'update-balance/amount');
  }
  if (type !== 'add' && type !== 'subtract') {
    return fail(res, 400, "type must be 'add' or 'subtract'", null, 'update-balance/type');
  }

  try {
    const phone = normalisePhone(phoneNumber);
    const user = await findUserByPhone(phone);
    if (!user) return fail(res, 404, 'User not found', null, 'update-balance/user');

    const signedMinor = type === 'add' ? valueMinor : -valueMinor;
    const result = await ledger.moveBalance({
      userId: user.id,
      amountMinor: signedMinor,
      reason: type === 'add' ? ledger.REASONS.ADMIN_CREDIT : ledger.REASONS.ADMIN_DEBIT,
      refType: 'admin',
      refId: req.admin.username,
      metadata: { via: 'update-balance' }
    });

    if (!result.ok) {
      auditAdminAction(req.admin, 'balance.adjust.failed', {
        userId: user.id,
        phone,
        type,
        amount: fromMinor(valueMinor),
        error: result.reason
      });
      return fail(
        res,
        result.reason === 'Insufficient balance' ? 400 : 500,
        result.reason === 'Insufficient balance' ? 'Insufficient balance' : 'Could not update balance',
        null,
        'update-balance/ledger'
      );
    }

    auditAdminAction(req.admin, 'balance.adjust', {
      userId: user.id,
      phone,
      type,
      amount: fromMinor(valueMinor),
      balanceAfter: fromMinor(result.balance)
    });
    res.json({
      status: true,
      balance: fromMinor(result.balance),
      message: `${type === 'add' ? 'Credit' : 'Debit'} of ${fromMinor(valueMinor)} MWK applied`
    });
  } catch (error) {
    return fail(res, 500, 'Could not update balance', error, 'update-balance');
  }
});

// Operator credit (e.g. after an offline / mobile-money transfer).
// Ledger-backed, so the movement is atomic and appears in the player's
// statement as a DEPOSIT rather than as an unexplained balance edit.
router.post('/deposit', requireAdmin, async (req, res) => {
  const { phoneNumber, amount } = req.body || {};

  if (!validatePhone(phoneNumber)) {
    return fail(res, 400, 'Valid phone number is required', null, 'deposit/phone');
  }
  const valueMinor = toMinor(amount);
  if (valueMinor === null || valueMinor === 0) {
    return fail(res, 400, 'Invalid deposit amount', null, 'deposit/amount');
  }

  try {
    const phone = normalisePhone(phoneNumber);
    const user = await findUserByPhone(phone);
    if (!user) return fail(res, 404, 'User not found', null, 'deposit/user');

    const result = await ledger.credit({
      userId: user.id,
      amountMinor: valueMinor,
      reason: ledger.REASONS.DEPOSIT,
      refType: 'admin',
      refId: req.admin.username,
      metadata: { via: 'manual-deposit' }
    });

    if (!result.ok) {
      return fail(res, 500, 'Deposit failed', null, 'deposit/ledger');
    }

    auditAdminAction(req.admin, 'balance.credit', {
      userId: user.id,
      phone,
      amount: fromMinor(valueMinor),
      balanceAfter: fromMinor(result.balance)
    });
    res.json({
      status: true,
      balance: fromMinor(result.balance),
      message: `Deposited ${fromMinor(valueMinor)} MWK successfully`
    });
  } catch (error) {
    return fail(res, 500, 'Deposit failed', error, 'deposit');
  }
});

// Operator payout.
// NOTE: this is a manual book-balance debit, not a real mobile-money transfer.
// It records no withdrawal record and sends nothing to the player's wallet. For
// auditable payouts use POST /api/payments/withdrawals + the admin approval
// queue, which hold funds, snapshot the destination and write an audit trail.
router.post('/withdraw', requireAdmin, async (req, res) => {
  const { phoneNumber, amount } = req.body || {};

  if (!validatePhone(phoneNumber)) {
    return fail(res, 400, 'Valid phone number is required', null, 'withdraw/phone');
  }
  const valueMinor = toMinor(amount);
  if (valueMinor === null || valueMinor === 0) {
    return fail(res, 400, 'Invalid withdrawal amount', null, 'withdraw/amount');
  }

  try {
    const phone = normalisePhone(phoneNumber);
    const user = await findUserByPhone(phone);
    if (!user) return fail(res, 404, 'User not found', null, 'withdraw/user');

    const result = await ledger.debit({
      userId: user.id,
      amountMinor: valueMinor,
      reason: ledger.REASONS.ADMIN_DEBIT,
      refType: 'admin',
      refId: req.admin.username,
      metadata: { via: 'manual-withdraw' }
    });

    if (!result.ok) {
      return fail(
        res,
        result.reason === 'Insufficient balance' ? 400 : 500,
        result.reason === 'Insufficient balance' ? 'Insufficient balance' : 'Withdrawal failed',
        null,
        'withdraw/ledger'
      );
    }

    auditAdminAction(req.admin, 'balance.debit', {
      userId: user.id,
      phone,
      amount: fromMinor(valueMinor),
      balanceAfter: fromMinor(result.balance)
    });
    res.json({
      status: true,
      balance: fromMinor(result.balance),
      message: `Deducted ${fromMinor(valueMinor)} MWK from the account`
    });
  } catch (error) {
    return fail(res, 500, 'Withdrawal failed', error, 'withdraw');
  }
});

/**
 * Audit record for operator balance movements.
 *
 * Delegates to services/audit.js, which redacts secrets and never throws. The
 * previous inline version wrote only when Supabase was configured and carried
 * no actor, so operator actions could not be attributed.
 */
function auditAdminAction(admin, action, meta) {
  writeAuditLog({
    action: String(action).slice(0, 60),
    actor: (admin && admin.username) || 'admin',
    status: String(action).includes('.failed') ? 'failed' : 'success',
    details: meta || {}
  }).catch(() => {});
}

module.exports = router;