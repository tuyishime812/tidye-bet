/**
 * Player suspension checks shared by the HTTP and socket layers.
 *
 * `users.is_banned` exists in SCHEMA.sql but was never enforced: a suspended
 * player could still log in and place bets. This module is the single place
 * that answers "is this account allowed to move money right now?".
 *
 * A short positive/negative cache keeps the hot betting path cheap in database
 * mode (at most one indexed lookup per player per few seconds). Mutating
 * endpoints call invalidate() so a ban takes effect immediately.
 */
const memoryStore = require('../config/memoryStore');
const { getSupabase, isSupabaseAvailable } = require('../config/supabase');

const TTL_MS = 5000;
const cache = new Map();

function invalidate(userId) {
  if (userId == null) return;
  cache.delete(String(userId));
}

/**
 * @param {string} userId
 * @param {{strict?: boolean}} [opts] strict: propagate a lookup failure instead
 *   of failing open. Money-moving HTTP routes use this so a database outage
 *   cannot silently disable suspension enforcement; the hot betting path leaves
 *   it off so one failed status read does not stop the whole platform.
 * @returns {Promise<boolean>} true when the account is suspended
 */
async function isBanned(userId, opts = {}) {
  if (!userId || typeof userId !== 'string') return false;

  const key = String(userId);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.banned;

  let banned = false;

  if (!isSupabaseAvailable()) {
    const user = memoryStore.findUserById(key);
    banned = Boolean(user && user.is_banned);
    cache.set(key, { banned, expires: Date.now() + TTL_MS });
    return banned;
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('users')
      .select('is_banned')
      .eq('id', key)
      .limit(1);

    if (error) throw error;
    banned = Boolean(data && data.length && data[0].is_banned);
    cache.set(key, { banned, expires: Date.now() + TTL_MS });
    return banned;
  } catch (error) {
    // Fail open on an infrastructure error: blocking every bet because one
    // status lookup failed would take the platform down. The ban is still
    // enforced at login, and the next successful lookup re-syncs the cache.
    // Money-moving HTTP routes ask for strict mode, which converts the same
    // failure into a 503 instead of an allowed request.
    console.error('[playerStatus] ban lookup failed:', error.message);
    if (opts.strict) throw error;
    cache.set(key, { banned: false, expires: Date.now() + 1000 });
    return false;
  }
}

/** Drop the whole cache (used by tests). */
function clearCache() {
  cache.clear();
}

module.exports = { isBanned, invalidate, clearCache };
