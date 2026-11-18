/**
 * Authentication / authorisation middleware.
 *
 * SECURITY NOTES
 * --------------
 *  - Tokens are always verified against the fail-closed secret from
 *    config/auth.js. There is deliberately no inline fallback such as
 *    'default-secret': a hard-coded fallback that is present in the repository
 *    lets anybody mint an admin token and rewrite every user balance.
 *  - User routes and admin routes are kept separate (CWE-269). An admin token
 *    is rejected on user routes and a user token is rejected on admin routes,
 *    so a token can never be replayed across the privilege boundary.
 *  - Every limiter sets `standardHeaders` so clients can see the remaining
 *    budget, and a JSON body is always returned instead of express-rate-limit's
 *    default HTML page (the API is JSON-only).
 */
const { verifyUserToken, verifyAdminToken } = require('../config/auth');
const playerStatus = require('../services/playerStatus');

/** Extract a bearer token from the Authorization header. */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length ? token : null;
}

/**
 * Require a valid *user* token. Populates req.user on success.
 * Admin tokens are rejected to prevent privilege confusion.
 */
function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ status: false, message: 'No token provided' });
  }

  const decoded = verifyUserToken(token);
  if (!decoded) {
    return res.status(401).json({ status: false, message: 'Invalid or expired token' });
  }

  req.user = {
    userId: decoded.userId,
    userName: decoded.userName,
    phoneNumber: decoded.phoneNumber
  };
  req.token = token;
  return next();
}

/**
 * Require an authenticated player whose account is not suspended.
 *
 * Compose AFTER requireAuth on every route that can move money. The login path
 * already rejects banned accounts, but a JWT issued before the ban stays valid
 * for its full lifetime, so the flag has to be re-checked at the money boundary
 * (CWE-613: Insufficient Session Expiration).
 *
 * playerStatus is cached for 5 seconds and invalidated by the admin routes, so
 * this costs at most one indexed lookup per player per few seconds.
 */
async function requireActivePlayer(req, res, next) {
  const userId = req.user && req.user.userId;
  // requireAuth should already guarantee this. Rejecting here means a missing
  // identity can never be treated as "not banned" by the check below.
  if (!userId) {
    return res.status(401).json({ status: false, message: 'Unauthorized' });
  }

  try {
    // Strict mode: a failed status lookup is a 503, not an implicit "active".
    const banned = await playerStatus.isBanned(userId, { strict: true });
    if (banned) {
      return res.status(403).json({
        status: false,
        message: 'This account has been suspended. Please contact support.'
      });
    }
  } catch (error) {
    console.error('[auth] ban check failed:', error && error.message);
    return res.status(503).json({
      status: false,
      message: 'Account status could not be verified. Please try again.'
    });
  }
  return next();
}

/**
 * Require a valid *admin* token. Populates req.admin on success.
 * User tokens are rejected here.
 */
function requireAdmin(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ status: false, message: 'Unauthorized - admin token required' });
  }

  const decoded = verifyAdminToken(token);
  if (!decoded) {
    return res.status(401).json({ status: false, message: 'Invalid admin token' });
  }

  req.admin = decoded;
  req.token = token;
  return next();
}

/** Build a limiter that answers with JSON and a stable message. */
function buildLimiter({ windowMs, max, message }) {
  const rateLimit = require('express-rate-limit').rateLimit;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({
        status: false,
        message: message || 'Too many requests. Please try again later.'
      })
  });
}

/** Accept either positional (windowMs, max) or an options object. */
function normaliseOptions(a, b, defaults) {
  if (a && typeof a === 'object') return { ...defaults, ...a };
  return { ...defaults, windowMs: a ?? defaults.windowMs, max: b ?? defaults.max };
}

/**
 * Credential-stuffing protection. Keyed on IP + the submitted identifier so a
 * single attacker cannot lock out every user behind a shared NAT, while still
 * capping attempts per account.
 */
function credentialLimiter(windowMs = 15 * 60_000, max = 10) {
  const { windowMs: win, max: cap } = normaliseOptions(windowMs, max, {
    windowMs: 15 * 60_000,
    max: 10,
    message: 'Too many attempts. Please wait before trying again.'
  });

  const limiter = buildLimiter({ windowMs: win, max: cap });

  // The limiter itself is built here, at module load, so express-rate-limit's
  // ERR_ERL_CREATED_IN_REQUEST_HANDLER validation is satisfied.
  const baseKeyGenerator = limiter.keyGenerator || ((req) => req.ip);

  const keyed = (req) => {
    const identifier =
      (req.body && (req.body.phoneNumber || req.body.userName || req.body.username)) || '';
    return `${baseKeyGenerator(req)}:${String(identifier)}`;
  };

  limiter.keyGenerator = keyed;
  return limiter;
}

/** Broad per-IP ceiling applied to API routes. */
function apiLimiter(windowMs = 60_000, max = 120) {
  const { windowMs: win, max: cap } = normaliseOptions(windowMs, max, {
    windowMs: 60_000,
    max: 120,
    message: 'Too many requests. Please try again shortly.'
  });
  return buildLimiter({ windowMs: win, max: cap });
}

/**
 * Pre-built instance for general API traffic.
 *
 * IMPORTANT: build limiters at module load and pass the instance to app.use().
 * Writing app.use(path, apiLimiter(), router) constructs a new limiter on every
 * request, which express-rate-limit rejects with
 * ERR_ERL_CREATED_IN_REQUEST_HANDLER, and which would also never accumulate a
 * request count - silently disabling the rate limit.
 */
const apiRateLimit = apiLimiter(60_000, 200);

module.exports = {
  requireAuth,
  requireActivePlayer,
  requireAdmin,
  credentialLimiter,
  apiLimiter,
  apiRateLimit,
  bearerToken,
  // Legacy alias: routes/payment.js still imports verifyToken.
  verifyToken: requireAuth
};
