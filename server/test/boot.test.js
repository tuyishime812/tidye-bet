/**
 * Boot-time fail-closed validation tests.
 *
 * Run:  node server/test/boot.test.js
 *
 * Each case spawns a child process because the validator under test calls
 * process.exit(1) - which would take the test runner down with it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const AUTH_CONFIG = path.join(__dirname, '..', 'config', 'auth.js');

/**
 * Load config/auth.js in a child process with the given env and report whether
 * it threw (exited non-zero) or loaded cleanly.
 */
function tryBoot(env) {
  const script = `require(${JSON.stringify(AUTH_CONFIG)}).jwtSecret(); console.log('LOADED');`;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8'
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  };
}

const GOOD_SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6';

test('boots with a strong random secret', () => {
  const r = tryBoot({ JWT_SECRET: GOOD_SECRET });
  assert.equal(r.ok, true, `should boot, stderr: ${r.stderr}`);
  assert.match(r.stdout, /LOADED/);
});

test('REFUSES TO BOOT when JWT_SECRET is missing', () => {
  const r = tryBoot({});
  assert.equal(r.ok, false, 'must exit non-zero');
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /JWT_SECRET/);
});

test('REFUSES TO BOOT with the committed .env.example placeholder', () => {
  // This is the critical case: the placeholder is 46 chars, so a length-only
  // check accepts it - and it is published in the repository.
  const r = tryBoot({ JWT_SECRET: 'your-super-secret-jwt-key-change-this-in-production' });
  assert.equal(r.ok, false, 'placeholder secret must be fatal');
  assert.match(r.stderr, /FATAL/);
});

test('REFUSES TO BOOT with a short secret', () => {
  const r = tryBoot({ JWT_SECRET: 'short123' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /too short/);
});

test('REFUSES TO BOOT with the historical hard-coded default', () => {
  for (const weak of ['default-secret', 'changeme', 'secret']) {
    const r = tryBoot({ JWT_SECRET: weak.padEnd(30, '.') });
    assert.equal(r.ok, false, `"${weak}" must be fatal`);
  }
});

test('REFUSES TO BOOT with a low-entropy secret', () => {
  // Long enough to pass a length check, but trivially guessable.
  const r = tryBoot({ JWT_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /entropy/i);
});

test('REFUSES TO BOOT when admin credentials are weak', () => {
  const script = `require(${JSON.stringify(AUTH_CONFIG)}).getAdminCredentials(); console.log('LOADED');`;
  const base = { JWT_SECRET: GOOD_SECRET, ADMIN_USERNAME: 'admin' };

  // Default "admin123" from the old code / .env.example.
  const weak = spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, ...base, ADMIN_PASSWORD: 'admin123' },
    encoding: 'utf8'
  });
  assert.notEqual(weak.status, 0, 'admin123 must be fatal');
  assert.match(weak.stderr, /ADMIN_PASSWORD/);

  // Missing entirely.
  const missing = spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, ...base, ADMIN_PASSWORD: '' },
    encoding: 'utf8'
  });
  assert.notEqual(missing.status, 0, 'missing admin password must be fatal');

  // A proper 12+ character password boots.
  const good = spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, ...base, ADMIN_PASSWORD: 'a-long-enough-passphrase' },
    encoding: 'utf8'
  });
  assert.equal(good.status, 0, 'strong admin password should boot');
});

test('boots with an email identifier and a bcrypt password hash', () => {
  const script = `require(${JSON.stringify(AUTH_CONFIG)}).getAdminCredentials(); console.log('LOADED');`;
  const hash = bcrypt.hashSync('shift04@', 10);
  const r = spawnSync(process.execPath, ['-e', script], {
    env: {
      PATH: process.env.PATH,
      JWT_SECRET: GOOD_SECRET,
      ADMIN_EMAIL: 'tuyishimemartin@gmail.com',
      ADMIN_PASSWORD_HASH: hash
    },
    encoding: 'utf8'
  });
  assert.equal(r.status, 0, r.stderr || 'hashed admin password should boot');
  assert.match(r.stdout, /LOADED/);
});