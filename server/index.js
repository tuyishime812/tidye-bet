/**
 * Aviator platform server.
 *
 * SECURITY: see SECURITY_REPORT.md. The highest-impact changes in this file
 * are (1) failing closed on a weak JWT secret / default admin password,
 * (2) requiring an authenticated socket before any bet is accepted, and
 * (3) tightening the CORS allow-list which previously matched any *.vercel.app
 * or *.onrender.com deployment.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const {
  getSupabase,
  isSupabaseAvailable,
  getStorageMode,
  getUnavailableReason
} = require('./config/supabase');
const memoryStore = require('./config/memoryStore');
const {
  jwtSecret,
  getAdminCredentials,
  verifyUserToken,
  verifyAdminToken
} = require('./config/auth');
const { requireAdmin, credentialLimiter, apiRateLimit } = require('./middleware/auth');
const { verifySchema, describe: describeSchema } = require('./services/schemaCheck');
const adminAuth = require('./services/adminAuth');
const adminDirectory = require('./services/adminDirectory');
const { writeAuditLog } = require('./services/audit');
const playerStatus = require('./services/playerStatus');
const {
  manualCrashAllowed,
  manualCrashReason,
  manualCrashDefault,
  manualCrashFallbackMs
} = require('./config/gameControls');

dotenv.config();

const app = express();
const server = http.createServer(app);

// Trust exactly one proxy hop (Nginx on loopback). Without this, req.ip is the
// proxy address and express-rate-limit refuses to key on X-Forwarded-For.
app.set('trust proxy', 1);

// Fail fast on weak/missing secrets, before any traffic is accepted.
//
// Admin identity is database-backed by default (SCHEMA.sql SECTION 7b). The env
// ADMIN_USERNAME/ADMIN_PASSWORD pair is now only a bootstrap account: once the
// database holds at least one admin it stops being a login path, and
// ADMIN_AUTH_MODE=db drops it entirely (see services/adminAuth.js).
const ADMIN_AUTH_MODE = adminAuth.adminAuthMode();

if (ADMIN_AUTH_MODE === 'db') {
  if (!isSupabaseAvailable()) {
    console.error(
      '\n[FATAL] ADMIN_AUTH_MODE=db requires a configured database.\n' +
      '        Set USE_SUPABASE=true plus SUPABASE_URL / SUPABASE_KEY /\n' +
      '        SUPABASE_SERVICE_ROLE_KEY and apply server/SCHEMA.sql (the\n' +
      '        admins table is created in SECTION 7b), then restart.\n'
    );
    process.exit(1);
  }
} else if (ADMIN_AUTH_MODE === 'supabase') {
  const { isSupabaseAuthConfigured } = require('./config/supabase');
  if (!isSupabaseAuthConfigured()) {
    console.error(
      '\n[FATAL] ADMIN_AUTH_MODE=supabase requires Supabase Auth to be configured.\n' +
      '        Set SUPABASE_URL and SUPABASE_KEY (anon) or SUPABASE_SERVICE_ROLE_KEY\n' +
      '        in server/.env, then restart.\n'
    );
    process.exit(1);
  }
  // Supabase Auth is the only credential source for admin login.
} else {
  // 'auto' (default) and 'env' both keep the env bootstrap account, so it must
  // be strong: getAdminCredentials() exits on weak or missing values.
  getAdminCredentials();
}
jwtSecret(); // exits on weak or missing JWT secret

/**
 * CORS allow-list.
 *
 * SECURITY: the previous config used `/\.vercel\.app$/` and `/\.onrender\.com$/`,
 * which match ANY Vercel or Render deployment. Anyone able to spin up a
 * throwaway https://evil.vercel.app project could call this API. Set
 * FRONTEND_URL to your exact origin; Vercel subdomains are matched as strict
 * suffixes so https://x.vercel.app cannot impersonate https://y.vercel.app.
 */
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  process.env.FRONTEND_URL,
  process.env.ADMIN_SITE_URL
]
  .filter(Boolean)
  .map((origin) => origin.replace(/\/+$/, ''));

/**
 * Development-only convenience.
 *
 * CRA silently falls back to the next free port when 3000 is taken (3001,
 * 3002, …) and the app is often opened from a phone on the LAN during testing.
 * In development we therefore accept any localhost / RFC1918 private-network
 * origin regardless of port. Production still uses the strict allow-list above.
 *
 * SECURITY: a public attacker's Origin is never localhost or a private IP, so
 * even a misconfigured NODE_ENV cannot be used to smuggle a remote site past
 * this branch.
 */
function isDevelopmentOrigin(origin) {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) return true;
    if (/^10\./.test(hostname)) return true;                       // 10.0.0.0/8
    if (/^192\.168\./.test(hostname)) return true;                 // 192.168.0.0/16
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;  // 172.16.0.0/12
    if (/^169\.254\./.test(hostname)) return true;                 // link-local
    return false;
  } catch (error) {
    return false;
  }
}

function isOriginAllowed(origin) {
  if (!origin) return true; // native apps, curl, server-to-server
  const normalised = origin.replace(/\/+$/, '');

  if (!IS_PRODUCTION && isDevelopmentOrigin(normalised)) return true;

  return allowedOrigins.some((allowed) => {
    if (allowed.startsWith('http://localhost') || allowed.startsWith('http://127.0.0.1')) {
      return normalised === allowed;
    }
    try {
      const host = new URL(allowed).hostname;
      // Exact match, or a genuine subdomain of the configured host.
      return normalised === allowed || normalised.endsWith(`.${host}`);
    } catch (error) {
      return normalised === allowed;
    }
  });
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    console.warn('Blocked by CORS:', origin);
    // Tagged so the error handler can answer 403 instead of a generic 500.
    // A rejected origin is a client error, not a server fault, and returning
    // 500 made every blocked request look like a platform outage in logs.
    const err = new Error('Origin not allowed');
    err.code = 'CORS_ORIGIN_DENIED';
    return callback(err);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Baseline hardening headers (CWE-693).
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; " +
      "style-src 'self' 'unsafe-inline' https:; font-src 'self' data:; " +
      "connect-src 'self' ws: wss: http: https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  );
  next();
});

// Cap request bodies well below Express's 100kb default (CWE-400 resource abuse).
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));

// Supabase client is initialized in config/supabase.js
//
// SECURITY: this check FAILS CLOSED in production.
//
// The previous version swallowed a failed connection and continued in in-memory
// mode. That is a fail-open money path: on a transient DB outage the whole
// platform would silently move balances into process RAM, every restart would
// lose them, the atomic apply_movement RPC would be unavailable, and -
// because memory users are a different population from DB users — it would look
// like it "worked" while quietly serving empty or wrong balances. A betting
// platform must not accept bets it cannot durably record.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

async function verifyDatabaseConnection(attempts = 3, delayMs = 2000) {
  if (!isSupabaseAvailable()) {
    const reason = getUnavailableReason();
    if (IS_PRODUCTION) {
      console.error(`\n[FATAL] Production requires a working database (reason: ${reason}).`);
      console.error('        Refusing to start a betting platform that cannot persist');
      console.error('        balances or settle bets durably.\n');
      process.exit(1);
    }
    console.warn(`⚠️  Database unavailable (${reason}) - running in local memory mode.`);
    console.warn('   Balances and bets will NOT survive a restart. Dev only.');
    return false;
  }

  const supabase = getSupabase();

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`⏳ Checking database connection (attempt ${attempt}/${attempts})...`);
      const { error } = await supabase.from('users').select('id').limit(1);
      if (!error) {
        console.log('✅ Database connected');

        // Connectivity is not enough: prove the AUTHORITATIVE schema is
        // installed (money tables + the apply_movement RPC). This turns a
        // silent, unverified schema into a loud, actionable failure at boot
        // rather than an opaque error on the first deposit.
        const schema = await verifySchema(supabase);
        if (schema.ok) {
          console.log(`✅ ${describeSchema(schema)}`);
          return true;
        }

        console.error(`❌ ${describeSchema(schema)}`);
        console.error('   Apply the authoritative schema, then restart:');
        console.error('     psql "$SUPABASE_DB_URL" -f server/SCHEMA.sql');
        if (IS_PRODUCTION) {
          console.error('\n[FATAL] Production requires the authoritative schema.');
          console.error('        Refusing to start without apply_movement() and the money tables,');
          console.error('        because balances would not be written atomically.\n');
          process.exit(1);
        }
        console.warn('⚠️  Continuing in development despite schema problems (dev only).');
        return true;
      }
      console.error(`❌ Database connection failed: ${error.message}`);
    } catch (error) {
      console.error(`❌ Database connection error: ${error.message}`);
    }

    if (attempt < attempts) {
      console.log(`🔄 Retrying in ${delayMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Retries exhausted.
  if (IS_PRODUCTION) {
    console.error('\n[FATAL] Could not reach the database after all attempts.');
    console.error('        Refusing to start in production rather than run on in-memory');
    console.error('        balances that would be lost or double-counted.\n');
    process.exit(1);
  }
  console.warn('⚠️  Could not reach the database - continuing in local memory mode.');
  return false;
}

// Socket.IO setup with the same CORS policy
const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e5
});

// Import routes and game logic
const gameRoutes = require('./routes/game');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const paymentRoutes = require('./routes/payments');
const adminUserRoutes = require('./routes/adminUsers');
const { initializeGame, getGameInstance } = require('./game/gameLogic');

// Admin login limiter - the admin panel is a high-value target.
const adminLoginLimiter = credentialLimiter(15 * 60_000, 8);

// ============================================
// ROUTES
// ============================================

// NOTE: apiRateLimit is a single pre-built limiter instance (see
// middleware/auth.js). Constructing a limiter inside app.use() would rebuild it
// on every request and silently disable rate limiting entirely.
app.use('/api/auth', apiRateLimit, authRoutes);
app.use('/api/game', apiRateLimit, gameRoutes);
app.use('/api/chat', apiRateLimit, chatRoutes);
app.use('/api/payments', apiRateLimit, paymentRoutes);

// Admin player management. requireAdmin rejects user tokens, so this surface is
// only reachable by an operator. It used to be written but never mounted, which
// left 445 lines of account-management code unreachable.
app.use('/api/admin/users', apiRateLimit, requireAdmin, adminUserRoutes);

// ============================================
// ADMIN API
// ============================================

/**
 * Sign an admin session token.
 *
 * `typ: 'admin'` namespaces the token: verifyAdminToken() requires it AND
 * isAdmin, while verifyUserToken() rejects it outright, so an admin token can
 * never be replayed against a player route (CWE-269). `username`/`role` are
 * carried so the dashboard can render who is signed in.
 */
function signAdminToken(username, role) {
  const { sign } = require('jsonwebtoken');
  return sign(
    { isAdmin: true, typ: 'admin', username, role: role || 'ADMIN' },
    jwtSecret(),
    { expiresIn: '12h', algorithm: 'HS256' }
  );
}

/**
 * Admin login.
 *
 * SECURITY: authentication is delegated to services/adminAuth.js, which uses
 * bcrypt against the database `admins` table and only falls back to the env
 * bootstrap account when the database owns no admins (or is unavailable in dev).
 * Failures are rate limited and constant-time-ish (the directory compares
 * against a dummy hash when the username is unknown). The response is identical
 * for unknown-user and wrong-password.
 */
app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
  const { username, password, email } = req.body || {};
  const identifier = username != null && username !== '' ? username : email;

  try {
    const result = await adminAuth.authenticateAdmin(identifier, password);

    if (!result.ok) {
      if (result.reason === 'unavailable') {
        return res.status(503).json({
          success: false,
          message: 'Admin sign-in is temporarily unavailable. Please try again shortly.'
        });
      }
      if (result.reason === 'forbidden') {
        return res.status(403).json({
          success: false,
          message: 'This account is not an administrator.'
        });
      }
      writeAuditLog({
        action: 'ADMIN_LOGIN',
        actor: typeof identifier === 'string' ? identifier : null,
        status: 'failed',
        ip: req.ip,
        details: { reason: result.reason }
      }).catch(() => {});
      // Deliberately vague, and identical for unknown-user vs wrong-password.
      return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
    }

    const token = signAdminToken(result.admin.username, result.admin.role);

    writeAuditLog({
      action: 'ADMIN_LOGIN',
      actor: result.admin.username,
      status: 'success',
      ip: req.ip,
      details: { source: result.source, role: result.admin.role }
    }).catch(() => {});

    // Stamp last login for database admins (best effort; never blocks login).
    if (result.source === 'db' && result.admin.id) {
      adminDirectory.touchLastLogin(result.admin.id, req.ip);
    }

    // `status` mirrors `success` so every client (some check `status`, some
    // check `success`) sees a consistent envelope.
    return res.json({
      success: true,
      status: true,
      token,
      username: result.admin.username,
      role: result.admin.role
    });
  } catch (error) {
    console.error('[admin] login error:', error.message);
    return res.status(500).json({ success: false, message: 'Sign-in failed. Please try again.' });
  }
});

// ============================================
// ADMIN ACCOUNT MANAGEMENT (database-backed)
// ============================================
// Optional convenience API so the dashboard can manage admin accounts. Accounts
// can equally be created/rotated from the Supabase SQL editor (see
// ADMIN_API.md), which needs no code at all. Every route below requires a valid
// admin token, and all of them need the database because the env bootstrap
// account has no directory row to manage.
function adminDirectoryReady(res) {
  if (!isSupabaseAvailable()) {
    res.status(503).json({
      success: false,
      message: 'Admin account management requires the database (USE_SUPABASE=true).'
    });
    return false;
  }
  return true;
}

/** List admin accounts (never includes password hashes). */
app.get('/api/admin/admins', requireAdmin, async (req, res) => {
  if (!adminDirectoryReady(res)) return;
  const result = await adminDirectory.listAdmins();
  if (!result.ok) {
    return res.status(503).json({ success: false, message: 'Could not load admin accounts.' });
  }
  res.json({ success: true, admins: result.admins });
});

/** Create an admin account. */
app.post('/api/admin/admins', requireAdmin, async (req, res) => {
  if (!adminDirectoryReady(res)) return;
  const { username, password, role, displayName } = req.body || {};

  const result = await adminDirectory.createAdmin({
    username,
    password,
    role,
    displayName,
    createdBy: req.admin && req.admin.username
  });

  if (!result.ok) {
    if (result.code === 'EXISTS') {
      return res.status(409).json({ success: false, message: 'An admin with that username already exists.' });
    }
    if (result.code === 'INVALID') {
      return res.status(400).json({ success: false, message: result.message || 'Invalid admin details.' });
    }
    if (result.code === 'no-table') {
      return res.status(503).json({ success: false, message: 'The admins table is not installed. Apply SCHEMA.sql.' });
    }
    return res.status(500).json({ success: false, message: 'Could not create the admin account.' });
  }

  writeAuditLog({
    action: 'ADMIN_CREATED',
    actor: req.admin && req.admin.username,
    status: 'success',
    ip: req.ip,
    details: { username: result.admin.username, role: result.admin.role }
  }).catch(() => {});

  return res.status(201).json({ success: true, admin: result.admin });
});

/** Update an admin's password, role, active flag or display name. */
app.patch('/api/admin/admins/:id', requireAdmin, async (req, res) => {
  if (!adminDirectoryReady(res)) return;
  const { password, role, isActive, displayName } = req.body || {};

  const result = await adminDirectory.updateAdmin(req.params.id, {
    password,
    role,
    isActive,
    displayName
  });

  if (!result.ok) {
    if (result.code === 'NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    if (result.code === 'LAST_ADMIN') {
      return res.status(409).json({ success: false, message: 'Refusing to deactivate the last active admin.' });
    }
    if (result.code === 'INVALID') {
      return res.status(400).json({ success: false, message: result.message || 'Invalid update.' });
    }
    return res.status(503).json({ success: false, message: 'Could not update the admin account.' });
  }

  writeAuditLog({
    action: 'ADMIN_UPDATED',
    actor: req.admin && req.admin.username,
    status: 'success',
    ip: req.ip,
    details: { target: result.admin.username, fields: Object.keys(req.body || {}) }
  }).catch(() => {});

  return res.json({ success: true, admin: result.admin });
});

/** Delete an admin account. Refuses to remove the last active admin. */
app.delete('/api/admin/admins/:id', requireAdmin, async (req, res) => {
  if (!adminDirectoryReady(res)) return;

  const result = await adminDirectory.deleteAdmin(req.params.id);

  if (!result.ok) {
    if (result.code === 'NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    if (result.code === 'LAST_ADMIN') {
      return res.status(409).json({ success: false, message: 'Refusing to delete the last active admin.' });
    }
    return res.status(503).json({ success: false, message: 'Could not delete the admin account.' });
  }

  writeAuditLog({
    action: 'ADMIN_DELETED',
    actor: req.admin && req.admin.username,
    status: 'success',
    ip: req.ip,
    details: { id: req.params.id }
  }).catch(() => {});

  return res.json({ success: true });
});

/** Get current admin / game state. */
app.get('/api/admin/state', requireAdmin, (req, res) => {
  const game = getGameInstance();
  res.json({ success: true, ...game.getAdminState() });
});

/**
 * Manual crash control is a money-minting primitive and is therefore gated.
 *
 * Every attempt (allowed or denied) is audited with the acting operator, so a
 * disputed round can be traced back to the person who forced it.
 */
function manualControlDenied(res) {
  return res.status(403).json({
    success: false,
    message: `Manual crash control is disabled. (${manualCrashReason()})`
  });
}

/** Set the next round's crash point (manual control). */
app.post('/api/admin/crash-point', requireAdmin, async (req, res) => {
  const game = getGameInstance();
  const actor = (req.admin && req.admin.username) || 'unknown-admin';
  const { value } = req.body || {};

  if (!manualCrashAllowed()) {
    await writeAuditLog({
      action: 'CRASH_POINT_OVERRIDE',
      actor,
      status: 'failed',
      ip: req.ip,
      details: { reason: 'manual_control_disabled', value }
    });
    return manualControlDenied(res);
  }

  const result = game.setNextCrashPoint(value, actor);
  await writeAuditLog({
    action: 'CRASH_POINT_OVERRIDE',
    actor,
    status: result.success ? 'success' : 'failed',
    ip: req.ip,
    details: {
      value,
      crashPoint: result.crashPoint || null,
      round: game.getAdminState().currentRound,
      error: result.error || null
    }
  });
  return res.json(result);
});

/** Toggle full manual mode vs single override. */
app.post('/api/admin/mode', requireAdmin, async (req, res) => {
  const game = getGameInstance();
  const actor = (req.admin && req.admin.username) || 'unknown-admin';
  const enabled = Boolean(req.body && req.body.enabled);

  if (!manualCrashAllowed()) {
    await writeAuditLog({
      action: 'CRASH_MANUAL_MODE',
      actor,
      status: 'failed',
      ip: req.ip,
      details: { reason: 'manual_control_disabled', enabled }
    });
    return manualControlDenied(res);
  }

  const state = game.setAdminMode(enabled, actor);
  await writeAuditLog({
    action: 'CRASH_MANUAL_MODE',
    actor,
    status: 'success',
    ip: req.ip,
    details: { enabled, round: state.currentRound }
  });
  return res.json({ success: true, ...state });
});

/** Clear the forced crash point. */
app.post('/api/admin/clear', requireAdmin, async (req, res) => {
  const game = getGameInstance();
  const actor = (req.admin && req.admin.username) || 'unknown-admin';

  if (!manualCrashAllowed()) {
    await writeAuditLog({
      action: 'CRASH_POINT_CLEAR',
      actor,
      status: 'failed',
      ip: req.ip,
      details: { reason: 'manual_control_disabled' }
    });
    return manualControlDenied(res);
  }

  const result = game.clearNextCrashPoint();
  await writeAuditLog({
    action: 'CRASH_POINT_CLEAR',
    actor,
    status: 'success',
    ip: req.ip,
    details: { round: game.getAdminState().currentRound }
  });
  return res.json(result);
});

/** Health check. */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Anything else under /api is a 404 - do not fall through to a HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ status: false, message: 'Endpoint not found' });
});

// Initialize game instance
(async () => {
  await initializeGame(io);
})();

/**
 * Minimal in-process rate limiter for socket events (chat spam / bet spam).
 * A socket cannot use express-rate-limit, so we track per-IP windows here.
 */
function createSocketLimiter({ windowMs, max }) {
  const hits = new Map();

  function check(key) {
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    if (entry.count > max) return false;

    // Opportunistic sweep so the map cannot grow without bound.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) {
        if (now - v.start > windowMs) hits.delete(k);
      }
    }
    return true;
  }

  return { check, reset: () => hits.clear() };
}

const chatLimiter = createSocketLimiter({ windowMs: 10_000, max: 5 });
const betLimiterSocket = createSocketLimiter({ windowMs: 10_000, max: 12 });

// ============================================
// SOCKET.IO
// ============================================

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address || 'unknown';
  console.log('Client connected:', socket.id);

  const game = getGameInstance();

  /** Reject unauthenticated money-moving actions (CWE-306). */
  function requireUser(socketRef, replyEvent = 'error') {
    if (!socketRef.userId) {
      socketRef.emit(replyEvent, { message: 'Please log in to place bets' });
      return false;
    }
    return true;
  }

  /**
   * Resolve a session token onto this socket.
   *
   * Also used as a fallback by money events: a browser socket can miss its
   * initial `authenticate` (reconnect race, tab restore, remount) while the
   * REST session is still valid, which used to surface as "Please log in"
   * even though the player was signed in.
   */
  async function authenticateSocket(socketRef, token) {
    if (!token || typeof token !== 'string') return { ok: false, reason: 'no_token' };

    const decoded = verifyUserToken(token);
    if (!decoded) return { ok: false, reason: 'invalid_token' };

    let user = null;
    if (!isSupabaseAvailable()) {
      user = memoryStore.findUserById(decoded.userId);
    } else {
      const supabase = getSupabase();
      const { data } = await supabase.from('users').select('*').eq('id', decoded.userId).limit(1);
      user = data && data.length ? data[0] : null;
    }

    if (!user) return { ok: false, reason: 'user_not_found' };

    // A suspended account must not be able to authenticate a socket, even if
    // it still holds a valid, unexpired token from before the ban.
    if (user.is_banned) return { ok: false, reason: 'banned' };

    socketRef.userId = user.id;
    socketRef.userName = user.user_name;
    socketRef.avatar = user.avatar;

    // A reconnect gets a new socket id. Re-attach any bet the player placed
    // before the drop so they can still cash it out (or see it lose) instead
    // of the stake silently vanishing. Idempotent, so safe on every re-auth.
    game.rebindSocket(socketRef);
    return { ok: true, user };
  }

  // Handle authentication
  socket.on('authenticate', async (token) => {
    try {
      // Logging out (or an expired session) must drop the socket identity too,
      // otherwise the previous account stays able to bet on this connection.
      if (!token) {
        socket.userId = undefined;
        socket.userName = undefined;
        socket.avatar = undefined;
        socket.emit('authenticated', { success: false, message: 'No token provided' });
        return;
      }

      const result = await authenticateSocket(socket, token);
      if (!result.ok) {
        const message =
          result.reason === 'no_token'
            ? 'No token provided'
            : result.reason === 'banned'
              ? 'This account has been suspended. Please contact support.'
              : result.reason === 'user_not_found'
                ? 'User not found'
                : 'Invalid or expired session';
        socket.emit('authenticated', { success: false, message });
        return;
      }

      const user = result.user;

      socket.emit('authenticated', {
        success: true,
        user: {
          userName: user.user_name,
          balance: Number(user.balance) || 0,
          avatar: user.avatar
        }
      });
    } catch (error) {
      console.error('Authentication error:', error);
      socket.emit('authenticated', { success: false, message: 'Invalid session' });
    }
  });

  // Join game room
  socket.on('enterRoom', (data) => {
    socket.join('game-room');
    socket.emit('gameState', game.getGameState());
    socket.emit('betLimits', { max: game.maxBet, min: game.minBet });
    socket.emit('history', game.history);
  });

  /**
   * Place a bet.
   *
   * SECURITY: requires an authenticated socket. Previously `socket.userId` was
   * simply undefined for an anonymous client, and placeBet() skipped the
   * balance debit entirely, letting anyone bet with a zero balance.
   */
  socket.on('playBet', async (data) => {
    // The browser attaches its session token to the bet so a socket that lost
    // its authenticate event can still act on a valid login.
    if (!socket.userId && data && typeof data.token === 'string') {
      await authenticateSocket(socket, data.token);
    }
    if (!requireUser(socket)) return;
    if (!betLimiterSocket.check(`${clientIp}:bet`)) {
      socket.emit('error', { message: 'Too many bets, slow down', index: data && data.type });
      return;
    }
    // Re-check the ban flag: a socket authenticated before the ban must not be
    // able to keep betting until it reconnects.
    if (await playerStatus.isBanned(socket.userId)) {
      socket.emit('error', {
        message: 'This account has been suspended. Please contact support.',
        index: data && data.type
      });
      return;
    }
    game.placeBet(socket, data);
  });

  // Cash out
  socket.on('cashOut', async (data) => {
    if (!socket.userId && data && typeof data.token === 'string') {
      await authenticateSocket(socket, data.token);
    }
    if (!requireUser(socket)) return;
    if (!betLimiterSocket.check(`${clientIp}:cashout`)) {
      socket.emit('error', { message: 'Too many requests', index: data && data.type });
      return;
    }
    // Cashing out pays money out, so a suspended account must not do it either.
    // (Its existing stake is settled by the round's crash handler.)
    if (await playerStatus.isBanned(socket.userId)) {
      socket.emit('error', {
        message: 'This account has been suspended. Please contact support.',
        index: data && data.type
      });
      return;
    }
    game.cashOut(socket, data);
  });

  // Client changes their provably-fair seed
  socket.on('changeClientSeed', (seed) => {
    if (typeof seed === 'string' && seed.trim()) {
      if (seed.length > 128) return;
      game.addClientSeed(seed.trim());
      socket.emit('clientSeedChanged', { success: true });
    }
  });

  // Client requests the current server seed hash
  socket.on('getServerSeed', () => {
    socket.emit('serverSeed', game.getProvablyFairData());
  });

  /**
   * Chat messages.
   *
   * SECURITY: previously any socket could flood the room. Now rate limited,
   * length capped, and the sender identity is taken from the authenticated
   * socket rather than trusted from the payload (CWE-346 origin validation).
   */
  socket.on('sendMsg', (data) => {
    if (!chatLimiter.check(clientIp)) return;
    if (!requireUser(socket, 'chatError')) return;
    if (!data || typeof data !== 'object') return;

    const raw = data.msgContent || data.message;
    const message = typeof raw === 'string' ? raw.trim().slice(0, 280) : '';
    if (!message) return;

    const saved = memoryStore.pushChatMessage({
      userId: socket.userId,
      userName: socket.userName || 'Player',
      avatar: socket.avatar || '',
      msgType: typeof data.msgType === 'string' ? data.msgType.slice(0, 16) : 'text',
      msgContent: message
    });
    io.emit('msgReceived', saved);
  });

  // ============================================
  // ADMIN SOCKET EVENTS
  // ============================================

  socket.on('adminAuthenticate', (token) => {
    const decoded = typeof token === 'string' ? verifyAdminToken(token) : null;
    if (decoded) {
      socket.isAdmin = true;
      // Audit identity for every control action taken over this socket.
      socket.adminUsername = decoded.username || 'unknown-admin';
      socket.join('admin-room');
      socket.emit('adminAuthenticated', { success: true });
      socket.emit('adminState', game.getAdminState());
    } else {
      socket.emit('adminAuthenticated', { success: false, message: 'Admin access denied' });
    }
  });

  socket.on('setCrashPoint', async (data) => {
    if (!socket.isAdmin) {
      socket.emit('adminAction', { success: false, error: 'Admin access required' });
      return;
    }
    if (!manualCrashAllowed()) {
      await writeAuditLog({
        action: 'CRASH_POINT_OVERRIDE',
        actor: socket.adminUsername,
        status: 'failed',
        ip: clientIp,
        details: { reason: 'manual_control_disabled', value: data && data.value, via: 'socket' }
      });
      socket.emit('adminAction', {
        success: false,
        error: `Manual crash control is disabled. (${manualCrashReason()})`
      });
      return;
    }
    const result = game.setNextCrashPoint(data && data.value, socket.adminUsername);
    await writeAuditLog({
      action: 'CRASH_POINT_OVERRIDE',
      actor: socket.adminUsername,
      status: result.success ? 'success' : 'failed',
      ip: clientIp,
      details: {
        value: data && data.value,
        crashPoint: result.crashPoint || null,
        round: game.getAdminState().currentRound,
        error: result.error || null,
        via: 'socket'
      }
    });
    socket.emit('adminAction', result);
  });

  socket.on('setAdminMode', async (data) => {
    if (!socket.isAdmin) {
      socket.emit('adminAction', { success: false, error: 'Admin access required' });
      return;
    }
    if (!manualCrashAllowed()) {
      await writeAuditLog({
        action: 'CRASH_MANUAL_MODE',
        actor: socket.adminUsername,
        status: 'failed',
        ip: clientIp,
        details: {
          reason: 'manual_control_disabled',
          enabled: Boolean(data && data.enabled),
          via: 'socket'
        }
      });
      socket.emit('adminAction', {
        success: false,
        error: `Manual crash control is disabled. (${manualCrashReason()})`
      });
      return;
    }
    const state = game.setAdminMode(data && data.enabled, socket.adminUsername);
    await writeAuditLog({
      action: 'CRASH_MANUAL_MODE',
      actor: socket.adminUsername,
      status: 'success',
      ip: clientIp,
      details: { enabled: Boolean(data && data.enabled), round: state.currentRound, via: 'socket' }
    });
    socket.emit('adminAction', { success: true, ...state });
  });

  socket.on('clearCrashPoint', async () => {
    if (!socket.isAdmin) {
      socket.emit('adminAction', { success: false, error: 'Admin access required' });
      return;
    }
    if (!manualCrashAllowed()) {
      await writeAuditLog({
        action: 'CRASH_POINT_CLEAR',
        actor: socket.adminUsername,
        status: 'failed',
        ip: clientIp,
        details: { reason: 'manual_control_disabled', via: 'socket' }
      });
      socket.emit('adminAction', {
        success: false,
        error: `Manual crash control is disabled. (${manualCrashReason()})`
      });
      return;
    }
    const result = game.clearNextCrashPoint();
    await writeAuditLog({
      action: 'CRASH_POINT_CLEAR',
      actor: socket.adminUsername,
      status: 'success',
      ip: clientIp,
      details: { round: game.getAdminState().currentRound, via: 'socket' }
    });
    socket.emit('adminAction', result);
  });

  socket.on('getAdminState', () => {
    if (socket.isAdmin) socket.emit('adminState', game.getAdminState());
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    game.handleDisconnect(socket);
  });
});

// Error handling middleware - never leak stack traces to the client (CWE-209).
app.use((err, req, res, next) => {
  if (err && err.code === 'CORS_ORIGIN_DENIED') {
    // Deliberately terse: do not echo the rejected origin back, and do not
    // describe the allow-list, or this becomes an origin-discovery oracle.
    return res.status(403).json({ status: false, message: 'Forbidden' });
  }
  console.error('[server] Unhandled error:', (err && (err.stack || err.message)) || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ status: false, message: 'Something went wrong!' });
});

const PORT = process.env.PORT || 5001;

// Verify the database BEFORE accepting traffic. In production a failure here
// exits the process rather than silently degrading to in-memory balances.
verifyDatabaseConnection().then(() => {
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    const usingDb = isSupabaseAvailable();
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api`);
    console.log(`🔌 Socket.IO: ws://localhost:${PORT}`);
    console.log(`💰 Wallet:   http://localhost:${PORT}/api/payments/wallet`);
    console.log(`📊 Storage: ${usingDb ? 'POSTGRES (durable)' : 'LOCAL MEMORY (NOT durable)'}`);
    if (!usingDb) {
      console.log('   ⚠️  Balances reset on restart and the atomic debit is in-process-only.');
    }
    console.log(
      `🔐 Admin auth: ADMIN_AUTH_MODE=${ADMIN_AUTH_MODE}` +
        (usingDb ? ' (database-backed admins)' : ' (env bootstrap only)')
    );
    console.log(
      `🎛️  Crash control: ${manualCrashReason()}` +
        ` | start mode: ${manualCrashDefault() ? 'MANUAL' : 'AUTO'}` +
        (manualCrashDefault()
          ? ` | busy fallback: ${
              manualCrashFallbackMs() > 0
                ? `${Math.round(manualCrashFallbackMs() / 1000)}s`
                : 'off'
            }`
          : '')
    );

    console.log(`\n✅ CORS allow-list: ${allowedOrigins.join(', ') || '(none configured)'}\n`);
  });
}).catch((err) => {
  console.error('❌ Failed to initialize server:', err.message);
  process.exit(1);
});