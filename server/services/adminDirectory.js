/**
 * Admin directory - database-backed admin accounts (the `admins` table).
 *
 * WHY THIS EXISTS
 * ---------------
 * Admin login used to be a single username/password pair held in the server's
 * environment (ADMIN_USERNAME / ADMIN_PASSWORD). Adding, disabling or re-keying
 * an operator therefore meant editing .env on the host and redeploying, and the
 * platform could not tell two administrators apart.
 *
 * Accounts now live in Postgres (SCHEMA.sql SECTION 7b) and are managed from the
 * Supabase dashboard. This module is the only place that touches the table.
 *
 * SECURITY NOTES
 *   - Passwords are bcrypt hashes. `password_hash` is NEVER returned by the API
 *     helpers here; the mapped admin object omits it.
 *   - A wrong username must not be distinguishable from a wrong password by
 *     timing (CWE-208). When no row matches we still run a bcrypt comparison
 *     against a fixed dummy hash, so both paths cost roughly the same.
 *   - The table has RLS enabled with no policy, so the browser anon key can
 *     neither read nor write it. The server reaches it with the service-role
 *     key, which bypasses RLS.
 *   - Every function accepts an optional `client` so tests can inject a fake;
 *     production callers omit it and get the shared service-role client.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getSupabase } = require('../config/supabase');

const BCRYPT_ROUNDS = 12;

/** Realms that mean "the object is not installed" rather than a transient error. */
const MISSING_OBJECT_RE =
  /PGRST202|PGRST205|42883|42P01|does not exist|schema cache|not find the (function|table)/i;

const VALID_ROLES = new Set(['ADMIN', 'SUPERADMIN']);

/**
 * A valid bcrypt hash used only to equalise the cost of "unknown username" and
 * "wrong password". Computed lazily; the plaintext is random and irrelevant.
 */
let dummyHash = null;
function getDummyHash() {
  if (dummyHash === null) {
    dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);
  }
  return dummyHash;
}

function client(explicit) {
  return explicit || getSupabase();
}

/** Map a PostgREST/Postgres error to a coarse status the caller can act on. */
function mapError(error) {
  const text = `${(error && error.code) || ''} ${(error && error.message) || ''}`;
  if (MISSING_OBJECT_RE.test(text)) return 'no-table';
  return 'error';
}

/** Strip the hash before anything leaves this module. */
function toPublicAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role || 'ADMIN',
    displayName: row.display_name || null,
    isActive: row.is_active !== false,
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at || null
  };
}

/** True when the admins table is reachable. */
function isAvailable(db) {
  return Boolean(client(db));
}

/**
 * Look up an admin and verify the password.
 *
 * @returns {Promise<
 *   {status:'ok', admin:object} |
 *   {status:'invalid'} |
 *   {status:'inactive'} |
 *   {status:'no-table'} |
 *   {status:'error'}>}
 */
async function verify(username, password, db) {
  const supabase = client(db);
  if (!supabase) return { status: 'error' };

  const norm = String(username == null ? '' : username).trim();

  let row = null;
  try {
    const { data, error } = await supabase
      .from('admins')
      .select('id, username, password_hash, role, is_active')
      .eq('username_lower', norm.toLowerCase())
      .limit(1);
    if (error) return { status: mapError(error) };
    row = data && data[0] ? data[0] : null;
  } catch (error) {
    return { status: 'error' };
  }

  const submitted = String(password == null ? '' : password);

  if (!row) {
    // Keep the cost flat so a missing account cannot be told apart from a
    // wrong password (CWE-208 user enumeration via timing).
    await bcrypt.compare(submitted, getDummyHash());
    return { status: 'invalid' };
  }

  const matches = await bcrypt.compare(submitted, String(row.password_hash || ''));
  if (row.is_active === false) return { status: 'inactive' };
  if (!matches) return { status: 'invalid' };
  return { status: 'ok', admin: toPublicAdmin(row) };
}

/** Total admins, active or not. Used to decide env-bootstrap fallback. */
async function countAdmins(db) {
  const supabase = client(db);
  const { count, error } = await supabase
    .from('admins')
    .select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

/** Active admins other than `excludeId` - the last-admin guard. */
async function countOtherActiveAdmins(excludeId, db) {
  const supabase = client(db);
  const { count, error } = await supabase
    .from('admins')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .neq('id', excludeId);
  if (error) throw error;
  return count || 0;
}

/** All admins, hash-free, newest first. */
async function listAdmins(db) {
  const supabase = client(db);
  const { data, error } = await supabase
    .from('admins')
    .select('id, username, role, display_name, is_active, last_login_at, created_at')
    .order('created_at', { ascending: true });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, admins: (data || []).map(toPublicAdmin) };
}

/**
 * Create an admin.
 * @returns {Promise<{ok:true, admin:object} | {ok:false, code:'EXISTS'|'INVALID'|'no-table'|'error'}>}
 */
async function createAdmin({ username, password, role, displayName, createdBy }, db) {
  const supabase = client(db);

  const norm = String(username == null ? '' : username).trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(norm)) {
    return { ok: false, code: 'INVALID', message: 'Username must be 3-32 chars: letters, numbers, . _ -' };
  }
  if (typeof password !== 'string' || password.length < 12) {
    return { ok: false, code: 'INVALID', message: 'Password must be at least 12 characters' };
  }
  const finalRole = role === undefined || role === null ? 'ADMIN' : String(role).toUpperCase();
  if (!VALID_ROLES.has(finalRole)) {
    return { ok: false, code: 'INVALID', message: 'Role must be ADMIN or SUPERADMIN' };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const { data, error } = await supabase
      .from('admins')
      .insert([
        {
          username: norm,
          password_hash: passwordHash,
          role: finalRole,
          display_name: displayName ? String(displayName).slice(0, 120) : null,
          is_active: true,
          created_by: createdBy ? String(createdBy).slice(0, 60) : null
        }
      ])
      .select('id, username, role, display_name, is_active, last_login_at, created_at')
      .single();

    if (error) {
      if (error.code === '23505') return { ok: false, code: 'EXISTS' };
      return { ok: false, code: mapError(error) };
    }
    return { ok: true, admin: toPublicAdmin(data) };
  } catch (error) {
    return { ok: false, code: 'error' };
  }
}

/**
 * Update an admin's password / role / active flag / display name.
 * @returns {Promise<{ok:true, admin:object} | {ok:false, code:'NOT_FOUND'|'LAST_ADMIN'|'INVALID'|'no-table'|'error'}>}
 */
async function updateAdmin(id, patch, db) {
  const supabase = client(db);
  const ids = String(id || '');
  if (!ids) return { ok: false, code: 'INVALID', message: 'Admin id required' };

  const fields = {};

  if (patch.password !== undefined) {
    if (typeof patch.password !== 'string' || patch.password.length < 12) {
      return { ok: false, code: 'INVALID', message: 'Password must be at least 12 characters' };
    }
    fields.password_hash = await bcrypt.hash(patch.password, BCRYPT_ROUNDS);
  }
  if (patch.role !== undefined) {
    const role = String(patch.role).toUpperCase();
    if (!VALID_ROLES.has(role)) {
      return { ok: false, code: 'INVALID', message: 'Role must be ADMIN or SUPERADMIN' };
    }
    fields.role = role;
  }
  if (patch.displayName !== undefined) {
    fields.display_name = patch.displayName ? String(patch.displayName).slice(0, 120) : null;
  }
  if (patch.isActive !== undefined) {
    fields.is_active = Boolean(patch.isActive);
  }

  if (Object.keys(fields).length === 0) {
    return { ok: false, code: 'INVALID', message: 'Nothing to update' };
  }

  // Pre-flight the last-admin rule for a friendlier error than the DB trigger's.
  if (fields.is_active === false) {
    try {
      const others = await countOtherActiveAdmins(ids, db);
      if (others === 0) return { ok: false, code: 'LAST_ADMIN' };
    } catch (error) {
      return { ok: false, code: mapError(error) };
    }
  }

  try {
    const { data, error } = await supabase
      .from('admins')
      .update(fields)
      .eq('id', ids)
      .select('id, username, role, display_name, is_active, last_login_at, created_at');
    if (error) {
      if (/last active admin/i.test(error.message || '')) return { ok: false, code: 'LAST_ADMIN' };
      return { ok: false, code: mapError(error) };
    }
    if (!data || !data.length) return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, admin: toPublicAdmin(data[0]) };
  } catch (error) {
    return { ok: false, code: 'error' };
  }
}

/**
 * Delete an admin. Refuses to remove the last active one.
 * @returns {Promise<{ok:true} | {ok:false, code:'NOT_FOUND'|'LAST_ADMIN'|'no-table'|'error'}>}
 */
async function deleteAdmin(id, db) {
  const supabase = client(db);
  const ids = String(id || '');
  if (!ids) return { ok: false, code: 'INVALID' };

  try {
    const { data, error } = await supabase
      .from('admins')
      .select('id, is_active')
      .eq('id', ids)
      .limit(1);
    if (error) return { ok: false, code: mapError(error) };
    if (!data || !data.length) return { ok: false, code: 'NOT_FOUND' };

    if (data[0].is_active !== false) {
      const others = await countOtherActiveAdmins(ids, db);
      if (others === 0) return { ok: false, code: 'LAST_ADMIN' };
    }

    const { error: delError } = await supabase.from('admins').delete().eq('id', ids);
    if (delError) {
      if (/last active admin/i.test(delError.message || '')) return { ok: false, code: 'LAST_ADMIN' };
      return { ok: false, code: mapError(delError) };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'error' };
  }
}

/** Best-effort last-login stamp. Never throws. */
async function touchLastLogin(id, ip, db) {
  const supabase = client(db);
  if (!supabase || !id) return;
  try {
    await supabase
      .from('admins')
      .update({ last_login_at: new Date().toISOString(), last_login_ip: ip || null })
      .eq('id', id);
  } catch (error) {
    /* stamping last login must never break a successful login */
  }
}

module.exports = {
  BCRYPT_ROUNDS,
  VALID_ROLES,
  MISSING_OBJECT_RE,
  isAvailable,
  verify,
  countAdmins,
  countOtherActiveAdmins,
  listAdmins,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  touchLastLogin,
  toPublicAdmin,
  getDummyHash
};
