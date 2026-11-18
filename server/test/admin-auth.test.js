/**
 * Database-backed admin authentication tests.
 *
 * Run:  node server/test/admin-auth.test.js   (or: npm test)
 *
 * Covers services/adminAuth.js (which authority answers a login) and
 * services/adminDirectory.js (bcrypt verification, error mapping, and the
 * last-active-admin guard). No database is required: the directory accepts an
 * injected client and adminAuth accepts an injected directory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

// Keep config/supabase from attempting a real connection in this process.
process.env.USE_SUPABASE = process.env.USE_SUPABASE || 'false';

const adminAuth = require('../services/adminAuth');
const directory = require('../services/adminDirectory');

// ---------------------------------------------------------------------------
// A minimal fake PostgREST client. Every chain method records the call and
// returns the same builder; awaiting it (or calling .single()) invokes the
// supplied handler with the recorded operations.
// ---------------------------------------------------------------------------
function fakeClient(handler) {
  function builder(table, ops) {
    const self = {
      select: (...a) => { ops.push({ m: 'select', a }); return self; },
      insert: (...a) => { ops.push({ m: 'insert', a }); return self; },
      update: (...a) => { ops.push({ m: 'update', a }); return self; },
      delete: (...a) => { ops.push({ m: 'delete', a }); return self; },
      eq: (...a) => { ops.push({ m: 'eq', a }); return self; },
      neq: (...a) => { ops.push({ m: 'neq', a }); return self; },
      limit: (...a) => { ops.push({ m: 'limit', a }); return self; },
      order: (...a) => { ops.push({ m: 'order', a }); return self; },
      single: () => Promise.resolve(handler({ table, ops })),
      then: (resolve, reject) => Promise.resolve(handler({ table, ops })).then(resolve, reject)
    };
    return self;
  }
  return { from: (table) => builder(table, []) };
}

const has = (ops, name) => ops.some((o) => o.m === name);

// A `select('id', { count: 'exact', head: true })` count query is distinguishable
// from a row select by its second argument.
const isCount = (ops) => ops.some((o) => o.m === 'select' && o.a && o.a[1] && o.a[1].head === true);

// ---------------------------------------------------------------------------
// adminAuth.adminAuthMode / env helpers
// ---------------------------------------------------------------------------

test('adminAuthMode defaults to auto and normalises case', () => {
  assert.equal(adminAuth.adminAuthMode({}), 'auto');
  assert.equal(adminAuth.adminAuthMode({ ADMIN_AUTH_MODE: '' }), 'auto');
  assert.equal(adminAuth.adminAuthMode({ ADMIN_AUTH_MODE: 'DB' }), 'db');
  assert.equal(adminAuth.adminAuthMode({ ADMIN_AUTH_MODE: ' Env ' }), 'env');
  assert.equal(adminAuth.adminAuthMode({ ADMIN_AUTH_MODE: 'nonsense' }), 'auto');
});

test('matchesEnv is constant-length safe and requires both fields', () => {
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-enough-passphrase' };
  assert.equal(adminAuth.matchesEnv('admin', 'a-long-enough-passphrase', env), true);
  assert.equal(adminAuth.matchesEnv('admin', 'wrong', env), false);
  assert.equal(adminAuth.matchesEnv('someone', 'a-long-enough-passphrase', env), false);
  assert.equal(adminAuth.matchesEnv('admin', 'a-long-enough-passphrase', {}), false);
  assert.equal(adminAuth.envCredentials({ ADMIN_USERNAME: 'admin' }), null);
});

test('env login accepts an email identifier and a bcrypt password hash', () => {
  const hash = bcrypt.hashSync('shift04@', 10);
  const env = { ADMIN_EMAIL: 'tuyishimemartin@gmail.com', ADMIN_PASSWORD_HASH: hash };
  assert.equal(adminAuth.matchesEnv('tuyishimemartin@gmail.com', 'shift04@', env), true);
  // Email matching is case-insensitive; the password is not.
  assert.equal(adminAuth.matchesEnv('TUYISHIMEMARTIN@GMAIL.COM', 'shift04@', env), true);
  assert.equal(adminAuth.matchesEnv('tuyishimemartin@gmail.com', 'wrong', env), false);
  assert.equal(adminAuth.matchesEnv('someone@example.com', 'shift04@', env), false);
  assert.deepEqual(adminAuth.envCredentials(env), {
    username: 'tuyishimemartin@gmail.com',
    password: undefined,
    passwordHash: hash
  });
});

// ---------------------------------------------------------------------------
// authenticateAdmin - source selection
// ---------------------------------------------------------------------------

function fakeDirectory(overrides = {}) {
  return {
    verify: async () => ({ status: 'invalid' }),
    countAdmins: async () => 0,
    ...overrides
  };
}

test('db admin with the right password authenticates from the database', async () => {
  const dir = fakeDirectory({
    verify: async () => ({ status: 'ok', admin: { id: '1', username: 'boss', role: 'ADMIN' } })
  });
  const r = await adminAuth.authenticateAdmin('boss', 'pw', {
    directory: dir, env: {}, mode: 'auto', available: true
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'db');
  assert.equal(r.admin.username, 'boss');
});

test('db admin rejected; env account NOT used once the db owns admins', async () => {
  const dir = fakeDirectory({ verify: async () => ({ status: 'invalid' }), countAdmins: async () => 2 });
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-enough-passphrase' };
  const r = await adminAuth.authenticateAdmin('admin', 'a-long-enough-passphrase', {
    directory: dir, env, mode: 'auto', available: true
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('empty db falls back to the env bootstrap account (auto)', async () => {
  const dir = fakeDirectory({ verify: async () => ({ status: 'invalid' }), countAdmins: async () => 0 });
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-enough-passphrase' };
  const r = await adminAuth.authenticateAdmin('admin', 'a-long-enough-passphrase', {
    directory: dir, env, mode: 'auto', available: true
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'env');
  assert.equal(r.admin.username, 'admin');
});

test('empty db + wrong env password fails', async () => {
  const dir = fakeDirectory({ verify: async () => ({ status: 'invalid' }), countAdmins: async () => 0 });
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-enough-passphrase' };
  const r = await adminAuth.authenticateAdmin('admin', 'nope', {
    directory: dir, env, mode: 'auto', available: true
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('a disabled account never authenticates (and never falls back to env)', async () => {
  const dir = fakeDirectory({ verify: async () => ({ status: 'inactive' }) });
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-enough-passphrase' };
  const r = await adminAuth.authenticateAdmin('admin', 'a-long-enough-passphrase', {
    directory: dir, env, mode: 'auto', available: true
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('a database error fails closed as unavailable (no env downgrade)', async () => {
  const dir = fakeDirectory({ verify: async () => ({ status: 'error' }) });
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-enough-passphrase' };
  const r = await adminAuth.authenticateAdmin('admin', 'a-long-enough-passphrase', {
    directory: dir, env, mode: 'auto', available: true
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
});

test('a thrown directory error fails closed as unavailable', async () => {
  const dir = fakeDirectory({ verify: async () => { throw new Error('socket hang up'); } });
  const r = await adminAuth.authenticateAdmin('boss', 'pw', {
    directory: dir, env: {}, mode: 'auto', available: true
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
});

test('missing admins table falls back to env in auto, but not in db mode', async () => {
  const dir = fakeDirectory({ verify: async () => ({ status: 'no-table' }) });
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-enough-passphrase' };

  const auto = await adminAuth.authenticateAdmin('admin', 'a-long-enough-passphrase', {
    directory: dir, env, mode: 'auto', available: true
  });
  assert.equal(auto.ok, true);
  assert.equal(auto.source, 'env');

  const dbMode = await adminAuth.authenticateAdmin('admin', 'a-long-enough-passphrase', {
    directory: dir, env, mode: 'db', available: true
  });
  assert.equal(dbMode.ok, false);
  assert.equal(dbMode.reason, 'unavailable');
});

test('db mode without a database can never authenticate', async () => {
  const dir = fakeDirectory();
  const r = await adminAuth.authenticateAdmin('boss', 'pw', {
    directory: dir, env: {}, mode: 'db', available: false
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
});

test('env mode ignores the directory entirely', async () => {
  const dir = fakeDirectory({ verify: async () => { throw new Error('must not be called'); } });
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-enough-passphrase' };
  const r = await adminAuth.authenticateAdmin('admin', 'a-long-enough-passphrase', {
    directory: dir, env, mode: 'env', available: true
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'env');
});

test('auto mode without a database uses the env account', async () => {
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-enough-passphrase' };
  const r = await adminAuth.authenticateAdmin('admin', 'a-long-enough-passphrase', {
    directory: fakeDirectory(), env, mode: 'auto', available: false
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'env');
});

// ---------------------------------------------------------------------------
// adminDirectory.verify
// ---------------------------------------------------------------------------

const GOOD_PW = 'correct-horse-battery';
const GOOD_HASH = bcrypt.hashSync(GOOD_PW, 10);

test('directory.verify accepts the right password and strips the hash', async () => {
  const client = fakeClient(() => ({
    data: [{ id: '1', username: 'boss', password_hash: GOOD_HASH, role: 'ADMIN', is_active: true }],
    error: null
  }));
  const r = await directory.verify('BOSS', GOOD_PW, client);
  assert.equal(r.status, 'ok');
  assert.equal(r.admin.username, 'boss');
  assert.equal(r.admin.password_hash, undefined);
});

test('directory.verify rejects a wrong password', async () => {
  const client = fakeClient(() => ({
    data: [{ id: '1', username: 'boss', password_hash: GOOD_HASH, role: 'ADMIN', is_active: true }],
    error: null
  }));
  const r = await directory.verify('boss', 'wrong-password', client);
  assert.equal(r.status, 'invalid');
});

test('directory.verify reports an unknown username as invalid', async () => {
  const client = fakeClient(() => ({ data: [], error: null }));
  const r = await directory.verify('ghost', GOOD_PW, client);
  assert.equal(r.status, 'invalid');
});

test('directory.verify reports an inactive account distinctly', async () => {
  const client = fakeClient(() => ({
    data: [{ id: '1', username: 'boss', password_hash: GOOD_HASH, role: 'ADMIN', is_active: false }],
    error: null
  }));
  const r = await directory.verify('boss', GOOD_PW, client);
  assert.equal(r.status, 'inactive');
});

test('directory.verify maps a missing table to no-table', async () => {
  const client = fakeClient(() => ({
    data: null,
    error: { code: '42P01', message: 'relation "public.admins" does not exist' }
  }));
  const r = await directory.verify('boss', GOOD_PW, client);
  assert.equal(r.status, 'no-table');
});

test('directory.verify maps a generic error to error', async () => {
  const client = fakeClient(() => ({ data: null, error: { code: 'XX000', message: 'boom' } }));
  const r = await directory.verify('boss', GOOD_PW, client);
  assert.equal(r.status, 'error');
});

// ---------------------------------------------------------------------------
// adminDirectory CRUD validation & guards
// ---------------------------------------------------------------------------

test('createAdmin rejects invalid input before touching the database', async () => {
  const client = fakeClient(() => { throw new Error('db must not be reached'); });
  assert.equal((await directory.createAdmin({ username: 'ab', password: 'longenough123' }, client)).code, 'INVALID');
  assert.equal((await directory.createAdmin({ username: 'boss', password: 'short' }, client)).code, 'INVALID');
  assert.equal(
    (await directory.createAdmin({ username: 'boss', password: 'longenough123', role: 'GOD' }, client)).code,
    'INVALID'
  );
});

test('createAdmin maps a unique violation to EXISTS', async () => {
  const client = fakeClient(() => ({ data: null, error: { code: '23505', message: 'duplicate key' } }));
  const r = await directory.createAdmin({ username: 'boss', password: 'longenough123' }, client);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXISTS');
});

test('createAdmin returns a hash-free admin on success', async () => {
  const client = fakeClient(({ ops }) => {
    if (has(ops, 'insert')) {
      return {
        data: { id: '9', username: 'newbie', role: 'SUPERADMIN', display_name: null, is_active: true, created_at: 'now' },
        error: null
      };
    }
    return { data: null, error: null };
  });
  const r = await directory.createAdmin(
    { username: 'newbie', password: 'longenough123', role: 'SUPERADMIN' },
    client
  );
  assert.equal(r.ok, true);
  assert.equal(r.admin.username, 'newbie');
  assert.equal(r.admin.role, 'SUPERADMIN');
  assert.equal(r.admin.password_hash, undefined);
});

test('updateAdmin refuses to deactivate the last active admin', async () => {
  const client = fakeClient(({ ops }) => {
    if (has(ops, 'update')) throw new Error('update must not run when guard trips');
    return { count: 0, error: null }; // countOtherActiveAdmins -> 0
  });
  const r = await directory.updateAdmin('1', { isActive: false }, client);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LAST_ADMIN');
});

test('updateAdmin rejects a short password', async () => {
  const client = fakeClient(() => ({ data: null, error: null }));
  const r = await directory.updateAdmin('1', { password: 'short' }, client);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID');
});

test('deleteAdmin refuses to delete the last active admin', async () => {
  const client = fakeClient(({ ops }) => {
    if (has(ops, 'delete')) throw new Error('delete must not run when guard trips');
    if (isCount(ops)) return { count: 0, error: null };
    return { data: [{ id: '1', is_active: true }], error: null };
  });
  const r = await directory.deleteAdmin('1', client);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LAST_ADMIN');
});

test('deleteAdmin removes a non-last admin', async () => {
  const client = fakeClient(({ ops }) => {
    if (has(ops, 'delete')) return { error: null };
    if (isCount(ops)) return { count: 3, error: null };
    return { data: [{ id: '1', is_active: true }], error: null };
  });
  const r = await directory.deleteAdmin('1', client);
  assert.equal(r.ok, true);
});

test('deleteAdmin 404s an unknown id', async () => {
  const client = fakeClient(() => ({ data: [], error: null }));
  const r = await directory.deleteAdmin('missing', client);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});
