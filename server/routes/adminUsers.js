/**
 * Admin player management.
 *
 * Mounted at /api/admin/users behind requireAdmin. These routes let an operator
 * list players, edit their profile, reset a password, suspend/reinstate an
 * account and delete an empty account - the day-to-day "control everything"
 * back-office surface.
 *
 * SECURITY RULES ENFORCED HERE
 * ----------------------------
 *  - Mass assignment is impossible: only the keys listed in buildPatch() are
 *    ever written. `password`, `balance`, `id` and `user_type` cannot be set by
 *    spreading a request body (CWE-915).
 *  - Balance is never edited directly. Money moves only through the ledger
 *    (POST /api/payments/admin/credits), which keeps the append-only trail.
 *  - Every mutation is written to the audit log with the acting admin.
 *  - Password hashes are never returned by any endpoint.
 *  - Search input is sanitised before it reaches a PostgREST `or()` filter, so
 *    it cannot inject additional columns/operators (filter injection).
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { getSupabase, isSupabaseAvailable } = require('../config/supabase');
const memoryStore = require('../config/memoryStore');
const ledger = require('../services/ledger');
const playerStatus = require('../services/playerStatus');
const { writeAuditLog } = require('../services/audit');
const { validateDestination } = require('../services/payout');
const { normalisePhone, phoneLookupKeys } = require('../services/phone');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Columns safe to expose. Never includes `password` or 2FA secrets. */
const PUBLIC_COLUMNS = [
  'id',
  'user_name',
  'phone_number',
  'email',
  'balance',
  'held',
  'payout_phone',
  'avatar',
  'currency',
  'user_type',
  'is_banned',
  'ban_reason',
  'is_guest',
  'created_at',
  'last_login_at',
  'last_login_ip'
].join(', ');

function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    userName: row.user_name,
    phoneNumber: row.phone_number,
    email: row.email || '',
    balance: Number(row.balance) || 0,
    held: Number(row.held) || 0,
    payoutPhone: row.payout_phone || null,
    avatar: row.avatar || '',
    currency: row.currency || 'MWK',
    isAdminPlayer: Boolean(row.user_type),
    isBanned: Boolean(row.is_banned),
    banReason: row.ban_reason || null,
    isGuest: Boolean(row.is_guest),
    createdAt: row.created_at || null,
    lastLoginAt: row.last_login_at || null
  };
}

function fail(res, status, message) {
  return res.status(status).json({ status: false, message });
}

function audit(req, action, details, status = 'success') {
  writeAuditLog({
    action,
    actor: (req.admin && req.admin.username) || 'admin',
    status,
    ip: req.ip,
    details: details || {}
  }).catch(() => {});
}

/**
 * Sanitise a search term for a PostgREST `or()` filter.
 * Only characters that are meaningful in a username/phone/email are kept; the
 * SQL-ish metacharacters that PostgREST treats as operators are dropped.
 */
function sanitiseSearch(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .slice(0, 64)
    .replace(/[^A-Za-z0-9@._+-]/g, '');
}

async function findById(id) {
  if (!isSupabaseAvailable()) return memoryStore.findUserById(id);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('users')
    .select(PUBLIC_COLUMNS)
    .eq('id', id)
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

async function nameTaken(name, exceptId) {
  if (!isSupabaseAvailable()) {
    const other = memoryStore.findUserByName(name);
    return Boolean(other && other.id !== exceptId);
  }
  const supabase = getSupabase();
  let query = supabase.from('users').select('id').eq('user_name', name);
  if (exceptId) query = query.neq('id', exceptId);
  const { data } = await query.limit(1);
  return Boolean(data && data.length);
}

async function phoneTaken(phone, exceptId) {
  // Check every legacy spelling of the same subscriber, not just the canonical
  // value. Otherwise an operator could set `0991234567` on one account while
  // `+265991234567` already exists on another, bypassing the uniqueness rule
  // that registration enforces.
  const keys = phoneLookupKeys(phone);
  if (!keys.length) return false;

  if (!isSupabaseAvailable()) {
    return memoryStore
      .allUsers()
      .some((u) => u.id !== exceptId && keys.includes(String(u.phone_number || '')));
  }
  const supabase = getSupabase();
  let query = supabase.from('users').select('id').in('phone_number', keys);
  if (exceptId) query = query.neq('id', exceptId);
  const { data } = await query.limit(1);
  return Boolean(data && data.length);
}

// ============================================================================
// LIST
// ============================================================================

router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = sanitiseSearch(req.query.search || req.query.q);
  const bannedOnly = String(req.query.banned || '') === 'true';

  try {
    if (!isSupabaseAvailable()) {
      let users = memoryStore.allUsers();
      if (search) {
        const needle = search.toLowerCase();
        users = users.filter(
          (u) =>
            String(u.user_name || '').toLowerCase().includes(needle) ||
            String(u.phone_number || '').includes(needle) ||
            String(u.email || '').toLowerCase().includes(needle)
        );
      }
      if (bannedOnly) users = users.filter((u) => u.is_banned);

      users = [...users].sort(
        (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
      );

      const total = users.length;
      const page = users.slice(offset, offset + limit).map(safeUser);
      return res.json({ status: true, data: { users: page, total, limit, offset } });
    }

    const supabase = getSupabase();
    let query = supabase
      .from('users')
      .select(PUBLIC_COLUMNS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`user_name.ilike.%${search}%,phone_number.ilike.%${search}%,email.ilike.%${search}%`);
    }
    if (bannedOnly) query = query.eq('is_banned', true);

    const { data, error, count } = await query;
    if (error) throw error;

    return res.json({
      status: true,
      data: {
        users: (data || []).map(safeUser),
        total: typeof count === 'number' ? count : (data || []).length,
        limit,
        offset
      }
    });
  } catch (error) {
    console.error('[admin/users] list failed:', error.message);
    return fail(res, 500, 'Could not load players.');
  }
});

// ============================================================================
// READ ONE
// ============================================================================

router.get('/:id', async (req, res) => {
  try {
    const row = await findById(String(req.params.id));
    if (!row) return fail(res, 404, 'Player not found.');
    return res.json({ status: true, data: safeUser(row) });
  } catch (error) {
    console.error('[admin/users] read failed:', error.message);
    return fail(res, 500, 'Could not load the player.');
  }
});

/** Recent wallet movements for a player (read-only audit view). */
router.get('/:id/ledger', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const result = await ledger.getLedger(String(req.params.id), limit);
    if (!result.ok) return fail(res, 400, result.reason || 'Could not read the ledger.');
    return res.json({ status: true, data: result.entries || [] });
  } catch (error) {
    console.error('[admin/users] ledger failed:', error.message);
    return fail(res, 500, 'Could not read the ledger.');
  }
});

// ============================================================================
// UPDATE
// ============================================================================

/**
 * Build the allow-listed DB patch from a request body.
 * @returns {Promise<{patch: object, error?: string, status?: number, changes: string[]}>}
 */
async function buildPatch(id, body) {
  const patch = {};
  const changes = [];

  if (body.userName !== undefined) {
    const name = typeof body.userName === 'string' ? body.userName.trim() : '';
    if (!USERNAME_RE.test(name)) {
      return { patch, error: 'Username must be 3-20 letters or numbers.', status: 400 };
    }
    if (await nameTaken(name, id)) {
      return { patch, error: 'That username is already in use.', status: 409 };
    }
    patch.user_name = name;
    changes.push('userName');
  }

  if (body.phoneNumber !== undefined) {
    const raw = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';
    const phone = normalisePhone(raw);
    if (!phone) {
      return { patch, error: 'Enter a valid phone number.', status: 400 };
    }
    if (await phoneTaken(phone, id)) {
      return { patch, error: 'That phone number is already registered.', status: 409 };
    }
    patch.phone_number = phone;
    changes.push('phoneNumber');
  }

  if (body.email !== undefined) {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email && !EMAIL_RE.test(email)) {
      return { patch, error: 'Enter a valid email address.', status: 400 };
    }
    patch.email = email || null;
    changes.push('email');
  }

  if (body.payoutPhone !== undefined) {
    if (body.payoutPhone === null || body.payoutPhone === '') {
      patch.payout_phone = null;
    } else {
      const check = validateDestination(body.payoutPhone, 'mpamba');
      if (!check.ok) return { patch, error: check.reason, status: 400 };
      patch.payout_phone = check.normalised;
    }
    changes.push('payoutPhone');
  }

  if (body.avatar !== undefined) {
    const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : '';
    // Avatars are URLs/paths, never markup. Strip control characters and cap
    // the length so this cannot become a stored payload.
    if (avatar.length > 300 || /[\r\n<>]/.test(avatar)) {
      return { patch, error: 'Invalid avatar value.', status: 400 };
    }
    patch.avatar = avatar;
    changes.push('avatar');
  }

  if (body.isBanned !== undefined) {
    if (typeof body.isBanned !== 'boolean') {
      return { patch, error: 'isBanned must be true or false.', status: 400 };
    }
    patch.is_banned = body.isBanned;
    if (body.isBanned) {
      const reason =
        typeof body.banReason === 'string' ? body.banReason.trim().slice(0, 200) : '';
      patch.ban_reason = reason || 'Suspended by operator';
    } else {
      patch.ban_reason = null;
    }
    changes.push('isBanned');
  } else if (body.banReason !== undefined) {
    // Changing the reason only makes sense while suspended.
    patch.ban_reason = String(body.banReason).slice(0, 200);
    changes.push('banReason');
  }

  if (body.password !== undefined) {
    const password = body.password;
    const valid =
      typeof password === 'string' &&
      password.length >= 8 &&
      password.length <= 128 &&
      /[a-zA-Z]/.test(password) &&
      /[0-9]/.test(password);
    if (!valid) {
      return {
        patch,
        error: 'Password must be at least 8 characters and include a letter and a number.',
        status: 400
      };
    }
    patch.password = await bcrypt.hash(password, 12);
    changes.push('password');
  }

  return { patch, changes };
}

router.patch('/:id', async (req, res) => {
  const id = String(req.params.id);

  try {
    const existing = await findById(id);
    if (!existing) return fail(res, 404, 'Player not found.');

    const body = req.body || {};
    const { patch, error, status, changes } = await buildPatch(id, body);
    if (error) return fail(res, status || 400, error);
    if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to update.');

    if (!isSupabaseAvailable()) {
      memoryStore.updateUser(id, patch);
    } else {
      const supabase = getSupabase();
      const { error: updateError } = await supabase.from('users').update(patch).eq('id', id);
      if (updateError) {
        if (updateError.code === '23505') {
          return fail(res, 409, 'That username or phone number is already in use.');
        }
        throw updateError;
      }
    }

    // A ban (or unban) must take effect immediately on live sockets.
    if (changes.includes('isBanned')) playerStatus.invalidate(id);

    audit(req, 'PLAYER_UPDATED', { userId: id, fields: changes });

    const updated = await findById(id);
    return res.json({ status: true, data: safeUser(updated) });
  } catch (error) {
    console.error('[admin/users] update failed:', error.message);
    return fail(res, 500, 'Could not update the player.');
  }
});

// ============================================================================
// DELETE
// ============================================================================

/**
 * Delete a player.
 *
 * Financial records are append-only (balance_ledger) and reference the user
 * with ON DELETE RESTRICT. Deleting an account with any money history would
 * either destroy the audit trail or fail as a 500, so this refuses with a clear
 * 409 and points the operator at suspension instead. Empty accounts (no money,
 * no ledger rows) can be removed.
 */
router.delete('/:id', async (req, res) => {
  const id = String(req.params.id);

  try {
    const existing = await findById(id);
    if (!existing) return fail(res, 404, 'Player not found.');

    const balance = Number(existing.balance) || 0;
    const held = Number(existing.held) || 0;

    if (balance !== 0 || held !== 0) {
      return fail(
        res,
        409,
        'This player still holds funds. Suspended players with a balance cannot be deleted - ban the account instead.'
      );
    }

    if (!isSupabaseAvailable()) {
      const history = await ledger.getLedger(id, 1);
      if (history.ok && history.entries && history.entries.length) {
        return fail(
          res,
          409,
          'This player has wallet history and cannot be deleted. Ban the account instead.'
        );
      }
      memoryStore.deleteUser(id);
    } else {
      const supabase = getSupabase();
      const { error } = await supabase.from('users').delete().eq('id', id);
      if (error) {
        if (error.code === '23503') {
          return fail(
            res,
            409,
            'This player has financial records and cannot be deleted. Ban the account instead.'
          );
        }
        throw error;
      }
    }

    playerStatus.invalidate(id);
    audit(req, 'PLAYER_DELETED', { userId: id, userName: existing.user_name });

    return res.json({ status: true, message: 'Player deleted.' });
  } catch (error) {
    console.error('[admin/users] delete failed:', error.message);
    return fail(res, 500, 'Could not delete the player.');
  }
});

module.exports = router;
module.exports.safeUser = safeUser;
module.exports.sanitiseSearch = sanitiseSearch;
