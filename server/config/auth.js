/**
 * Centralised authentication helpers.
 *
 * SECURITY: the JWT secret MUST be configured. Previously every call site fell
 * back to the literal string 'default-secret', which meant that anyone who
 * could guess it (it is hard-coded in the repository) could mint a valid
 * *admin* token and take full control of the platform. We now fail closed at
 * boot instead of failing open at runtime.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const WEAK_SECRETS = new Set([
  'default-secret',
  'secret',
  'changeme',
  'your-secret-key',
  'test',
  'node_env',
  'your-super-secret-jwt-key-change-this-in-production',
  'supersecret',
  'password',
  'jwt_secret'
]);

/**
 * Substrings that mark a secret as an unfilled template rather than a real key.
 *
 * CWE-798 (Use of Hard-coded Credentials). Length checks alone are not enough:
 * the .env.example placeholder is 46 characters long, so a length-only rule
 * happily accepts it - and because the example file is committed to the repo,
 * the "secret" is public to anyone who clones it. Anyone copying the example
 * to .env without editing it would silently deploy a forgeable signing key.
 */
const PLACEHOLDER_PATTERNS = [
  'change-this',
  'change-me',
  'changethis',
  'changeme',
  'your-',
  'your_',
  'replace',
  'placeholder',
  'example',
  'insert-',
  'xxxxx',
  'todo',
  'fixme'
];

/** Minimum enforced secret length. */
const MIN_SECRET_LENGTH = 24;

/**
 * Detect a low-entropy secret such as "aaaaaaaaaaaaaaaa" or "1234567890123456",
 * which passes a length check but is trivially brute-forceable offline.
 */
function isLowEntropy(secret) {
  // A single repeated character.
  if (/^(.)\1+$/.test(secret)) return true;
  // Two alternating characters.
  if (/^(..)\1+$/.test(secret)) return true;
  // Very few distinct characters relative to length.
  const distinct = new Set(secret).size;
  if (distinct < 8) return true;
  return false;
}

/**
 * Resolve the JWT secret or terminate the process.
 * @returns {string}
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  const trimmed = typeof secret === 'string' ? secret.trim() : '';

  if (!trimmed || trimmed.length < MIN_SECRET_LENGTH) {
    console.error(
      `[FATAL] JWT_SECRET is missing or too short (minimum ${MIN_SECRET_LENGTH} characters).\n` +
      '        Refusing to start - a weak signing key would let an attacker\n' +
      '        forge admin tokens and manipulate every user balance.\n' +
      '        Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
    process.exit(1);
  }

  const lower = trimmed.toLowerCase();

  if (WEAK_SECRETS.has(lower)) {
    console.error('[FATAL] JWT_SECRET uses a well-known placeholder value. Refusing to start.');
    process.exit(1);
  }

  // Also reject a known-weak token that has been padded or decorated, e.g.
  // "default-secret................". Exact-match alone misses those.
  // Only long enough tokens are substring-matched so short generic words
  // ("test", "secret") cannot false-positive on a legitimate random secret.
  const embedded = [...WEAK_SECRETS].find((w) => w.length >= 8 && lower.includes(w));
  if (embedded) {
    console.error(
      `[FATAL] JWT_SECRET embeds the well-known weak value "${embedded}". Refusing to start.`
    );
    process.exit(1);
  }
  const hit = PLACEHOLDER_PATTERNS.find((p) => lower.includes(p));
  if (hit) {
    console.error(
      `[FATAL] JWT_SECRET still contains the placeholder fragment "${hit}".\n` +
      '        This value is published in .env.example, so anyone can forge tokens\n' +
      '        signed with it. Refusing to start.'
    );
    process.exit(1);
  }

  if (isLowEntropy(trimmed)) {
    console.error(
      '[FATAL] JWT_SECRET has too little entropy (repeated or low-variety characters).\n' +
      '        Refusing to start.'
    );
    process.exit(1);
  }

  if (trimmed.length < 32) {
    console.warn(
      `[WARN] JWT_SECRET is only ${trimmed.length} characters. 32+ random characters is recommended.`
    );
  }

  return trimmed;
}

/** Cached secret - read once at boot so env changes mid-run cannot swap keys. */
let cachedSecret = null;
function jwtSecret() {
  if (cachedSecret === null) cachedSecret = getJwtSecret();
  return cachedSecret;
}

/** A bcrypt hash as produced by bcryptjs / bcrypt ($2a$, $2b$ or $2y$). */
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** True when a string is a structurally valid bcrypt hash. */
function isBcryptHash(value) {
  return typeof value === 'string' && BCRYPT_HASH_RE.test(value.trim());
}

/**
 * Resolve the admin bootstrap credentials or terminate the process.
 *
 * The identifier may be either ADMIN_EMAIL or ADMIN_USERNAME (email wins), so an
 * operator can sign in with an email address without changing the old username
 * based deployments. The password may be supplied as plaintext ADMIN_PASSWORD
 * (12+ characters, kept for backwards compatibility) or, preferably, as a
 * bcrypt hash in ADMIN_PASSWORD_HASH. The hash form means the actual password is
 * never present in the environment file.
 */
function getAdminCredentials() {
  const email = process.env.ADMIN_EMAIL;
  const username = email || process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;

  const missing = [];
  if (!username || String(username).trim().length < 3) missing.push('ADMIN_EMAIL/ADMIN_USERNAME');

  const hasPlain = typeof password === 'string' && password.length > 0;
  const hasHash = isBcryptHash(passwordHash);

  if (!hasPlain && !hasHash) {
    missing.push('ADMIN_PASSWORD/ADMIN_PASSWORD_HASH');
  } else if (!hasHash && password.length < 12) {
    // A hash is checked structurally above; a plaintext password still has to
    // clear the old length floor so a short secret cannot be introduced via the
    // legacy path.
    missing.push('ADMIN_PASSWORD');
  }

  if (missing.length) {
    console.error(
      `[FATAL] Insecure admin credentials: ${missing.join(', ')} missing or too weak.\n` +
      '        Set ADMIN_EMAIL (or ADMIN_USERNAME) and either\n' +
      '        ADMIN_PASSWORD_HASH (preferred, bcrypt) or a 12+ character\n' +
      '        ADMIN_PASSWORD. Refusing to start rather than falling back to\n' +
      '        the public default "admin123".'
    );
    process.exit(1);
  }

  return {
    username: String(username).trim(),
    email: email ? String(email).trim() : undefined,
    password: hasHash ? null : password,
    passwordHash: hasHash ? String(passwordHash).trim() : null
  };
}

/**
 * Constant-time string comparison. Prevents timing oracles on secrets.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Hash first so differing lengths do not leak via an early return.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Issue a signed user token.
 * @param {{id: string, user_name: string, phone_number?: string}} user
 * @returns {string}
 */
function signUserToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      userName: user.user_name,
      phoneNumber: user.phone_number || undefined,
      typ: 'user'
    },
    jwtSecret(),
    { expiresIn: '7d', algorithm: 'HS256' }
  );
}

/**
 * Verify a token and guarantee it is a *user* token, never an admin token.
 *
 * Three independent checks, because any one of them alone is insufficient:
 *   1. signature + algorithm pinned to HS256 (blocks `alg: none` and RS/HS
 *      confusion attacks - CWE-347)
 *   2. `typ === 'user'` - the token namespace must match the route namespace.
 *      Without this, any token signed by this secret carrying a `userId` would
 *      be accepted on user routes (privilege confusion / CWE-269).
 *   3. `isAdmin !== true` - belt-and-braces; an admin token is always rejected.
 *
 * @param {string} token
 * @returns {object|null} decoded payload, or null when invalid
 */
function verifyUserToken(token) {
  if (typeof token !== 'string' || !token) return null;
  try {
    const decoded = jwt.verify(token, jwtSecret(), {
      algorithms: ['HS256'],
      // Reject anything signed with an unexpected algorithm.
      complete: false
    });
    if (!decoded || typeof decoded !== 'object') return null;
    if (decoded.isAdmin === true) return null;
    if (decoded.typ !== 'user') return null;
    if (!decoded.userId || typeof decoded.userId !== 'string') return null;
    return decoded;
  } catch (error) {
    return null;
  }
}

/**
 * Verify a token and guarantee it carries BOTH the admin claim and the admin
 * token namespace. A user token can never satisfy an admin route.
 * @param {string} token
 * @returns {object|null}
 */
function verifyAdminToken(token) {
  if (typeof token !== 'string' || !token) return null;
  try {
    const decoded = jwt.verify(token, jwtSecret(), {
      algorithms: ['HS256'],
      complete: false
    });
    if (!decoded || typeof decoded !== 'object') return null;
    if (decoded.isAdmin !== true) return null;
    if (decoded.typ !== 'admin') return null;
    return decoded;
  } catch (error) {
    return null;
  }
}

module.exports = {
  jwtSecret,
  getJwtSecret,
  getAdminCredentials,
  isBcryptHash,
  safeCompare,
  signUserToken,
  verifyUserToken,
  verifyAdminToken
};