/**
 * Supabase Auth (GoTrue) verification for admin sign-in.
 *
 * WHY: admin accounts can be created and rotated from the Supabase dashboard
 * (Authentication > Users) instead of the `admins` table or env vars. This
 * module performs the email + password check against GoTrue's password grant
 * endpoint. It does NOT decide whether the authenticated user is *allowed* to be
 * an admin — that authorization policy lives in services/adminAuth.js, because a
 * Supabase Auth account is just a user, and sign-ups may be open. Credential
 * check here, authorization there.
 *
 * SECURITY NOTES
 *  - The password is sent only over TLS to the project's own GoTrue endpoint.
 *  - A hard timeout + no redirects avoids hanging the request path on a slow or
 *    hostile upstream (CWE-400). Callers translate transport failures into
 *    'unavailable' (HTTP 503), never into a silent success or a downgrade.
 *  - The response is intentionally reduced to { status, user, code } so no token
 *    material can leak upward into logs or API responses.
 */
const axios = require('axios');
const { getSupabaseUrl, getSupabaseAuthKey } = require('../config/supabase');

const DEFAULT_TIMEOUT_MS = 10000;
const TOKEN_PATH = '/auth/v1/token?grant_type=password';

/**
 * Map a GoTrue non-2xx body onto a coarse code.
 * GoTrue uses several shapes depending on version: { error }, { error_code },
 * or { msg }.
 */
function errorCode(data) {
  if (!data || typeof data !== 'object') return null;
  return (
    data.error_code ||
    data.error ||
    data.msg ||
    (data.error_description ? 'invalid_grant' : null)
  );
}

/**
 * Verify an email + password against Supabase Auth.
 *
 * @param {string} email
 * @param {string} password
 * @param {object} [opts]
 * @param {string} [opts.url]  override project URL (tests)
 * @param {string} [opts.key]  override apikey (tests)
 * @param {number} [opts.timeout]
 * @returns {Promise<
 *   {status:'ok', user:object|null} |
 *   {status:'invalid', code?:string|null} |
 *   {status:'unavailable', code?:string|null} |
 *   {status:'unconfigured'}>}
 */
async function signInWithPassword(email, password, opts = {}) {
  const url = opts.url !== undefined ? opts.url : getSupabaseUrl();
  const key = opts.key !== undefined ? opts.key : getSupabaseAuthKey();

  if (!url || !key) return { status: 'unconfigured' };

  const endpoint = `${String(url).replace(/\/+$/, '')}${TOKEN_PATH}`;

  let res;
  try {
    res = await axios.post(
      endpoint,
      { email, password },
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        // Do not follow redirects: GoTrue never legitimately redirects this call,
        // and following one could send the password to an unintended host.
        maxRedirects: 0,
        timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
        // Inspect every status ourselves instead of throwing on 4xx.
        validateStatus: () => true
      }
    );
  } catch (error) {
    // Network error, DNS failure, timeout, TLS error: upstream is not usable.
    return { status: 'unavailable', code: error && error.code ? error.code : null };
  }

  const data = res.data;

  if (res.status >= 200 && res.status < 300 && data && data.access_token) {
    return { status: 'ok', user: data.user || null };
  }

  // 400/401/403/422 are the credential-rejection family.
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422) {
    return { status: 'invalid', code: errorCode(data) };
  }

  // 5xx / 429 (rate limited) / anything unexpected: treat as upstream trouble so
  // the caller fails closed rather than reporting "bad password".
  return { status: 'unavailable', code: errorCode(data) || `http_${res.status}` };
}

module.exports = { signInWithPassword };
