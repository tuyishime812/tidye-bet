/**
 * Authentication / authorization regression tests.
 *
 * Run:  node server/test/auth.test.js
 *
 * Covers the privilege boundary between player tokens and admin tokens, the
 * fail-closed JWT secret validator, and token-tampering resistance.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// A strong, non-placeholder secret so config/auth.js will load.
process.env.JWT_SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword12345';

const {
  jwtSecret,
  signUserToken,
  verifyUserToken,
  verifyAdminToken,
  safeCompare
} = require('../config/auth');

// ---------------------------------------------------------------------------
// Fail-closed secret validation
// ---------------------------------------------------------------------------

test('jwtSecret accepts a strong configured secret', () => {
  assert.equal(jwtSecret(), process.env.JWT_SECRET);
});

test('safeCompare is correct and does not leak via early return', () => {
  assert.equal(safeCompare('abc', 'abc'), true);
  assert.equal(safeCompare('abc', 'abd'), false);
  assert.equal(safeCompare('abc', 'abcd'), false);
  assert.equal(safeCompare('', ''), true);
  // Non-string inputs must not throw.
  assert.equal(safeCompare(null, 'abc'), false);
  assert.equal(safeCompare(undefined, undefined), false);
  assert.equal(safeCompare(123, '123'), false);
  assert.equal(safeCompare({}, {}), false);
});

// ---------------------------------------------------------------------------
// Token namespace separation (CWE-269 - privilege confusion)
// ---------------------------------------------------------------------------

test('a user token verifies as a user token', () => {
  const token = signUserToken({ id: 'u1', user_name: 'alice', phone_number: '991' });
  const decoded = verifyUserToken(token);
  assert.ok(decoded);
  assert.equal(decoded.userId, 'u1');
  assert.equal(decoded.userName, 'alice');
  assert.equal(decoded.typ, 'user');
});

test('an admin token is REJECTED on user routes', () => {
  const adminToken = jwt.sign(
    { isAdmin: true, typ: 'admin', username: 'root' },
    jwtSecret(),
    { expiresIn: '1h', algorithm: 'HS256' }
  );
  assert.equal(verifyUserToken(adminToken), null, 'admin token must not pass requireAuth');
});

test('a user token is REJECTED on admin routes', () => {
  const userToken = signUserToken({ id: 'u1', user_name: 'alice' });
  assert.equal(verifyAdminToken(userToken), null, 'user token must not pass requireAdmin');
});

test('a token missing the typ claim is rejected by both verifiers', () => {
  // This is the token shape that used to be accepted on user routes: signed,
  // carries a userId, but was never a real user token.
  const typeless = jwt.sign({ userId: 'u1', userName: 'mallory' }, jwtSecret(), {
    expiresIn: '1h',
    algorithm: 'HS256'
  });
  assert.equal(verifyUserToken(typeless), null);
});

test('an isAdmin token without typ:admin is rejected by verifyAdminToken', () => {
  const halfAdmin = jwt.sign({ isAdmin: true }, jwtSecret(), {
    expiresIn: '1h',
    algorithm: 'HS256'
  });
  assert.equal(verifyAdminToken(halfAdmin), null);
});

// ---------------------------------------------------------------------------
// Forgery / tampering resistance
// ---------------------------------------------------------------------------

test('a token signed with a different secret is rejected', () => {
  const forged = jwt.sign({ typ: 'user', userId: 'u1' }, 'attacker-controlled-secret', {
    expiresIn: '1h',
    algorithm: 'HS256'
  });
  assert.equal(verifyUserToken(forged), null);
});

test('an expired token is rejected', () => {
  const expired = jwt.sign({ typ: 'user', userId: 'u1' }, jwtSecret(), {
    expiresIn: '-1s',
    algorithm: 'HS256'
  });
  assert.equal(verifyUserToken(expired), null);
});

test('a tampered payload is rejected', () => {
  const token = signUserToken({ id: 'u1', user_name: 'alice' });
  const parts = token.split('.');
  const payload = JSON.parse(
    Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  );
  payload.userId = 'someone-else';
  const forgedPayload = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const tampered = `${parts[0]}.${forgedPayload}.${parts[2]}`;
  assert.equal(verifyUserToken(tampered), null, 'signature must cover the payload');
});

test('malformed tokens do not throw', () => {
  for (const bad of ['', 'abc', 'a.b.c', '....', null, undefined, 123, {}, []]) {
    assert.equal(verifyUserToken(bad), null);
    assert.equal(verifyAdminToken(bad), null);
  }
});

test('alg:none (unsigned) tokens are rejected', () => {
  // Classic CWE-347 algorithm-confusion attack: strip the signature entirely
  // and declare "none". jsonwebtoken must refuse to verify it.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const payload = Buffer.from(
    JSON.stringify({ typ: 'user', userId: 'u1', isAdmin: true }),
    'utf8'
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(verifyUserToken(`${header}.${payload}.`), null);
  assert.equal(verifyAdminToken(`${header}.${payload}.`), null);
});

test('a token signed with HS384 is rejected (algorithm pinning)', () => {
  const hs384 = jwt.sign({ typ: 'user', userId: 'u1' }, jwtSecret(), {
    expiresIn: '1h',
    algorithm: 'HS384'
  });
  assert.equal(verifyUserToken(hs384), null, 'only HS256 may be accepted');
});