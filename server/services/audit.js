/**
 * Audit logging for privileged and money-moving actions.
 *
 * REPLACES models/AuditLog.js, WHICH SILENTLY LOST EVERY ENTRY
 * -----------------------------------------------------------
 * The old implementation used a mongoose model, but `mongoose.connect()` is
 * never called anywhere in this codebase — the `isMemoryMode()` helper in
 * config/memoryStore.js only decides whether to read from Postgres, and the
 * connection itself was never opened. Mongoose therefore buffered every
 * `AuditLog.create()` call, waited out its 10-second `bufferTimeout`, and then
 * discarded the document. The result:
 *
 *   - Every deposit, withdrawal, payout and admin adjustment was UNLOGGED.
 *   - Every payment request was delayed by ~10s waiting for a buffer flush.
 *   - The failure was invisible: no error, no crash, just an empty audit table.
 *
 * A betting platform with no usable audit trail cannot answer "who paid out
 * 2,000,000 MWK last Tuesday", which is the first question asked in any dispute
 * or regulatory review. This module writes directly through the Supabase
 * client (which IS connected, or the server refuses to start) and keeps an
 * in-process ring buffer in dev so entries are still inspectable without a DB.
 *
 * DESIGN RULES
 *   - writeAuditLog() NEVER throws and NEVER returns a rejected promise. A
 *     logging failure must not turn a successful deposit into a 500 for the
 *     player, which would encourage retrying and double-crediting.
 *   - Never log secrets. Callers are responsible for not passing passwords,
 *     tokens or JWTs in `details`; `redact()` is a last-resort filter.
 *   - Details are size-capped so a hostile payload cannot bloat the table.
 */
const { getSupabase, isSupabaseAvailable } = require('../config/supabase');

/** Cap the in-process ring buffer so dev mode cannot leak memory. */
const MEM_LIMIT = 500;

/** Keep only the most recent entries. Newest first. */
const memAudit = [];

/** Values that must never reach the audit table, even by accident. */
const SECRET_KEYS = [
  'password',
  'newpassword',
  'oldpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'jwt',
  'secret',
  'apikey',
  'api_key',
  'provider_ref',
  'gatewaykey',
  'pin',
  'otp',
  'cvv',
  'cardnumber'
];

/** Hard cap on the serialised size of `details`. */
const MAX_DETAILS_CHARS = 2000;

/**
 * Strip anything that looks like a credential.
 *
 * Defence in depth (CWE-532: Insertion of Sensitive Information into Log File).
 * The primary control is not passing secrets in the first place; this catches
 * the case where a caller destructures a whole user object by mistake.
 */
function redact(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.includes(String(k).toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Record an audit entry.
 *
 * @param {object}  entry
 * @param {string}  entry.action   Dotted event name, e.g. 'WITHDRAWAL_PAID'.
 * @param {string} [entry.userId]  Subject of the action (the affected player).
 * @param {string} [entry.actor]  Who performed it (admin username, 'player').
 * @param {object} [entry.details] Structured context. Redacted automatically.
 * @param {string} [entry.status]  'success' | 'failed'.
 * @param {string} [entry.ip]
 * @returns {Promise<{ok:boolean, error?:string}>} never rejects
 */
async function writeAuditLog({ action, userId, actor, details, status, ip }) {
  const row = {
    action: String(action || 'UNKNOWN').slice(0, 60),
    user_id: userId || null,
    actor: (actor ? String(actor).slice(0, 60) : null),
    status: status === 'failed' ? 'failed' : 'success',
    details: safeSerialise(details),
    ip_address: ip ? String(ip).slice(0, 64) : null,
    created_at: new Date().toISOString()
  };

  memAudit.unshift(row);
  if (memAudit.length > MEM_LIMIT) memAudit.length = MEM_LIMIT;

  if (!isSupabaseAvailable()) return { ok: true, buffered: true };

  try {
    const { error } = await getSupabase().from('audit_logs').insert(row);
    if (error) {
      // Loudly logged server-side; never surfaced to the client.
      console.error('[audit] write failed:', error.message, '| action:', row.action);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (error) {
    console.error('[audit] write threw:', error.message, '| action:', row.action);
    return { ok: false, error: error.message };
  }
}

function safeSerialise(details) {
  if (!details) return {};
  let serialised;
  try {
    serialised = JSON.stringify(redact(details));
  } catch (error) {
    return { error: 'details were not serialisable' };
  }
  if (serialised.length <= MAX_DETAILS_CHARS) {
    try {
      return JSON.parse(serialised);
    } catch (error) {
      return { error: 'details were not serialisable' };
    }
  }
  // Truncate rather than drop: a partial record still tells an investigator
  // that something happened, which is the point of an audit log.
  return { truncated: true, preview: serialised.slice(0, MAX_DETAILS_CHARS) };
}

/**
 * Fire-and-forget variant for call sites that must not await logging.
 * Swallows rejections; the handler already catches its own.
 */
function auditFireAndForget(entry) {
  writeAuditLog(entry).catch(() => {});
}

/** Recent entries (memory ring buffer, plus Postgres when available). */
async function recentAudit({ userId, limit = 50, status } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);

  if (isSupabaseAvailable()) {
    try {
      let query = getSupabase()
        .from('audit_logs')
        .select('id, action, user_id, actor, status, details, ip_address, created_at')
        .order('created_at', { ascending: false })
        .limit(capped);
      if (userId) query = query.eq('user_id', userId);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) return { ok: false, entries: [], error: error.message };
      return { ok: true, entries: data || [] };
    } catch (error) {
      return { ok: false, entries: [], error: error.message };
    }
  }

  return {
    ok: true,
    entries: memAudit
      .filter((e) => (userId ? e.user_id === userId : true))
      .filter((e) => (status ? e.status === status : true))
      .slice(0, capped)
  };
}

module.exports = {
  writeAuditLog,
  auditFireAndForget,
  recentAudit,
  redact,
  MEM_LIMIT
};