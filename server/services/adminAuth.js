/**
 * Admin authentication orchestration.
 *
 * Admin accounts now live in the database (see services/adminDirectory.js and
 * SCHEMA.sql SECTION 7b). This module decides WHICH authority answers a login
 * attempt, so the policy is defined in exactly one place.
 *
 * ADMIN_AUTH_MODE (env) selects the policy:
 *
 *   'auto' (default)
 *     - If a database is configured AND it holds at least one admin row, the
 *       database is the sole authority. The env account is ignored, so once you
 *       create your first DB admin the ADMIN_USERNAME/ADMIN_PASSWORD pair stops
 *       being a login path.
 *     - If there is no database, or the `admins` table is empty/not installed,
 *       the env credentials are accepted as a bootstrap/break-glass account.
 *
 *   'db'
 *     - Database only. The env account is never accepted. Requires
 *       USE_SUPABASE=true + service-role key (validated at boot in index.js).
 *
 *   'env'
 *     - Environment only. The pre-existing behaviour; useful to pin the old
 *       single-account login even after the admins table exists.
 *
 *   'supabase'
 *     - Supabase Auth only. Login is an email + password checked against the
 *       project's GoTrue endpoint (services/supabaseAuth.js); the Supabase
 *       dashboard is the sole user store. Only identifiers that are allowed to
 *       administrate (see the authorization policy below) are accepted.
 *
 * SUPABASE AUTH SOURCE (all modes except 'env'/'db')
 * --------------------------------------------------
 * When the identifier looks like an email and Supabase Auth is configured, the
 * password is verified against GoTrue. A valid Supabase Auth account is NOT
 * automatically an administrator — anyone may be able to sign up — so the
 * authenticated user must additionally be *authorized*, by either:
 *   - an app_metadata claim of `is_admin: true` or `role: 'admin'` (set per user
 *     in the Supabase dashboard), or
 *   - membership of the ADMIN_EMAILS allow-list (comma/space separated).
 * Deny by default: no claim and no allow-list match means not an admin, even
 * with a correct password.
 *
 * FAILURE POLICY: a database error (connectivity, permission) results in
 * 'unavailable' (HTTP 503), never a silent downgrade to the env account. Fail
 * closed on the privileged path. The same holds for a GoTrue transport failure.
 *
 * Unit-testability: authenticateAdmin() accepts an injected directory, env,
 * supabaseAuth and configuration flags so tests exercise every branch with no
 * database and no network.
 */
const bcrypt = require('bcryptjs');
const { safeCompare, isBcryptHash } = require('../config/auth');
const { isSupabaseAvailable, isSupabaseAuthConfigured } = require('../config/supabase');
const directory = require('./adminDirectory');
const supabaseAuth = require('./supabaseAuth');

/** A deliberately strict email shape; used only to route to the Auth source. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Normalise ADMIN_AUTH_MODE; unrecognised values fall back to 'auto'. */
function adminAuthMode(env = process.env) {
  const raw = String(env.ADMIN_AUTH_MODE || 'auto').trim().toLowerCase();
  if (raw === 'db' || raw === 'env' || raw === 'auto' || raw === 'supabase') return raw;
  return 'auto';
}

/** The lowercase allow-list of admin emails from ADMIN_EMAILS. */
function adminEmails(env = process.env) {
  const raw = env.ADMIN_EMAILS;
  const set = new Set();
  if (!raw) return set;
  for (const part of String(raw).split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}

/**
 * Decide whether an authenticated Supabase Auth user may act as an admin.
 * Deny by default.
 *
 * @returns {{ok:true, email:string, role:string} | {ok:false}}
 */
function authorizeAuthUser(user, env = process.env) {
  const email = user && user.email ? String(user.email).trim().toLowerCase() : '';
  const meta = (user && user.app_metadata) || {};

  const claimedAdmin =
    meta.is_admin === true ||
    meta.is_admin === 'true' ||
    String(meta.role || '').toLowerCase() === 'admin';

  if (claimedAdmin) {
    const role = String(meta.role || '').toLowerCase() === 'admin' ? 'ADMIN' : 'ADMIN';
    return { ok: true, email: email || (user && user.id) || 'supabase-admin', role };
  }

  if (email && adminEmails(env).has(email)) {
    return { ok: true, email, role: 'ADMIN' };
  }

  return { ok: false };
}

/**
 * The configured env bootstrap credentials, or null when incomplete.
 *
 * `username` is the login identifier and may be an email address. `passwordHash`
 * is preferred over `password`; the hash is never the plaintext secret.
 */
function envCredentials(env = process.env) {
  const identifier = env.ADMIN_EMAIL || env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  const passwordHash = env.ADMIN_PASSWORD_HASH;
  if (!identifier || (!password && !isBcryptHash(passwordHash))) return null;

  return {
    username: String(identifier).trim(),
    password: typeof password === 'string' && password.length ? String(password) : undefined,
    passwordHash: isBcryptHash(passwordHash) ? String(passwordHash).trim() : undefined
  };
}

/**
 * Verify a login against the env bootstrap credentials.
 *
 * Email identifiers are compared case-insensitively (mailboxes are not case
 * sensitive), while a plain username keeps the historical exact-match behaviour.
 * The password is checked with bcrypt when a hash is configured; otherwise the
 * constant-time string comparison is used. Both checks are always evaluated so
 * an unknown identifier costs the same as a wrong password (CWE-208).
 */
function matchesEnv(username, password, env = process.env) {
  const creds = envCredentials(env);
  if (!creds) return false;

  const candidate = String(username == null ? '' : username).trim();
  const stored = creds.username;
  let userOk = safeCompare(candidate, stored);
  if (!userOk && stored.includes('@')) {
    userOk = safeCompare(candidate.toLowerCase(), stored.toLowerCase());
  }

  let passOk = false;
  if (creds.passwordHash) {
    try {
      passOk = bcrypt.compareSync(String(password == null ? '' : password), creds.passwordHash);
    } catch (_) {
      passOk = false;
    }
  } else {
    passOk = safeCompare(String(password == null ? '' : password), creds.password);
  }

  return userOk && passOk;
}

/**
 * Authenticate an admin login attempt.
 *
 * @param {string} username  username, or an email when using Supabase Auth
 * @param {string} password
 * @param {object} [opts]
 * @param {object} [opts.directory]  admin directory implementation (injectable)
 * @param {object} [opts.env]        environment bag (injectable)
 * @param {'auto'|'db'|'env'|'supabase'} [opts.mode]
 * @param {boolean} [opts.available] whether a database is configured
 * @param {object} [opts.supabaseAuth]  injectable GoTrue client (tests)
 * @param {boolean} [opts.authConfigured] whether Supabase Auth is configured
 * @returns {Promise<
 *   {ok:true, admin:{username:string, role:string, email?:string, id?:string},
 *    source:'db'|'env'|'supabase'} |
 *   {ok:false, reason:'invalid'|'unavailable'|'forbidden'}>}
 */
async function authenticateAdmin(username, password, opts = {}) {
  const env = opts.env || process.env;
  const mode = opts.mode || adminAuthMode(env);
  const dir = opts.directory || directory;
  const available = opts.available !== undefined ? opts.available : isSupabaseAvailable();

  const user = String(username == null ? '' : username).trim();
  const pass = String(password == null ? '' : password);

  const authConfigured =
    opts.authConfigured !== undefined ? opts.authConfigured : isSupabaseAuthConfigured();

  // ---- Supabase Auth source (email + password checked against GoTrue) --------
  const allowSupabaseAuth = mode === 'auto' || mode === 'supabase';
  const looksLikeEmail = EMAIL_RE.test(user);

  if (allowSupabaseAuth && looksLikeEmail) {
    if (!authConfigured) {
      // 'supabase' mode cannot authenticate anything without a project.
      if (mode === 'supabase') return { ok: false, reason: 'unavailable' };
      // 'auto': an email-shaped username may still exist in the table/env, so
      // fall through rather than reject outright.
    } else {
      const auth = opts.supabaseAuth || supabaseAuth;
      let result;
      try {
        result = await auth.signInWithPassword(user, pass);
      } catch (error) {
        result = { status: 'unavailable' };
      }

      if (result.status === 'ok') {
        const authz = authorizeAuthUser(result.user, env);
        if (authz.ok) {
          return {
            ok: true,
            source: 'supabase',
            admin: {
              username: authz.email,
              email: authz.email,
              role: authz.role,
              id: (result.user && result.user.id) || undefined
            }
          };
        }
        // Correct credentials, but this account is not an administrator.
        return { ok: false, reason: 'forbidden' };
      }
      if (result.status === 'unavailable') {
        // GoTrue is unreachable: fail closed, never downgrade to another source.
        return { ok: false, reason: 'unavailable' };
      }
      if (result.status === 'unconfigured') {
        if (mode === 'supabase') return { ok: false, reason: 'unavailable' };
        // fall through to the table/env sources
      } else if (mode === 'supabase') {
        // 'invalid': wrong password or unknown email. In 'supabase' mode this
        // is terminal. In 'auto' mode the same address may be the env bootstrap
        // account (ADMIN_EMAIL), so let the table/env sources decide below.
        return { ok: false, reason: 'invalid' };
      }
    }
  } else if (mode === 'supabase') {
    // Supabase Auth is the sole authority and a non-email identifier can never
    // be one.
    return { ok: false, reason: authConfigured ? 'invalid' : 'unavailable' };
  }

  const useDatabase = mode !== 'env' && available;

  if (useDatabase) {
    let lookup;
    try {
      lookup = await dir.verify(user, pass);
    } catch (error) {
      return { ok: false, reason: 'unavailable' };
    }

    switch (lookup.status) {
      case 'ok':
        return { ok: true, admin: lookup.admin, source: 'db' };
      case 'inactive':
        // Account exists but is disabled: never a valid login, and never falls
        // through to the env account.
        return { ok: false, reason: 'invalid' };
      case 'error':
        // Genuine database trouble - fail closed rather than downgrade.
        return { ok: false, reason: 'unavailable' };
      case 'no-table': {
        // Schema not applied yet: only the env bootstrap can help, and only in
        // the permissive 'auto' mode.
        if (mode === 'db') return { ok: false, reason: 'unavailable' };
        break;
      }
      default: {
        // 'invalid': no matching row, or a wrong password.
        // Decide env fallback by whether the database actually owns any admin.
        let total = 0;
        try {
          total = await dir.countAdmins();
        } catch (error) {
          return { ok: false, reason: 'unavailable' };
        }
        if (total > 0) return { ok: false, reason: 'invalid' };
        // Zero admins in the database: allow the bootstrap account (auto only).
        if (mode === 'db') return { ok: false, reason: 'invalid' };
        break;
      }
    }
  } else if (mode === 'db') {
    // 'db' mode without a database can never succeed.
    return { ok: false, reason: 'unavailable' };
  }

  // Environment bootstrap path (modes 'env' always; 'auto' when the database
  // holds no admins / is unavailable / is not installed).
  if (matchesEnv(user, pass, env)) {
    const creds = envCredentials(env);
    return { ok: true, admin: { username: creds.username, role: 'ENV' }, source: 'env' };
  }

  return { ok: false, reason: 'invalid' };
}

module.exports = {
  adminAuthMode,
  envCredentials,
  matchesEnv,
  adminEmails,
  authorizeAuthUser,
  authenticateAdmin
};
