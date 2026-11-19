/**
 * Test bootstrap - loaded with `node --require ./test/setup.js`.
 *
 * The suite exercises the in-memory store and ledger directly (it builds
 * fixtures with `local_*` ids via memoryStore.createUser). `server/.env`
 * normally points at a real Supabase project, so without this every test that
 * touched money tried to write those fake ids to Postgres and failed with
 * "invalid input syntax for type uuid".
 *
 * dotenv never overwrites variables that are already set, so pinning these
 * before any application module is required keeps the tests hermetic.
 */
process.env.USE_SUPABASE = 'false';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep durable local mode from writing test fixtures into server/data (and
// leaking them into the next run).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanga-bet-test-'));
process.env.LOCAL_DATA_DIR = dataDir;

process.on('exit', () => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (error) {
    /* best effort */
  }
});
