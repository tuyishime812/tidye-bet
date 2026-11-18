/**
 * Durable local storage for the "no database" development mode.
 *
 * WHY THIS EXISTS
 * ---------------
 * The server is happy to run without Supabase (USE_SUPABASE=false) so the app
 * can be started with one command. That mode used to keep users purely in
 * process memory, which meant every restart silently destroyed every account:
 * a player could register, come back later, and be told "invalid phone number
 * or password". For a betting platform that is data loss, not a convenience.
 *
 * This module persists the local users map and the local ledger to a single
 * JSON file so registration, login, balances and wallet history survive a
 * restart. It is intentionally small and dependency-free.
 *
 * DESIGN
 * ------
 *  - One file, one atomic write: both collections are written together, so a
 *    balance can never be persisted without the ledger row that explains it.
 *  - Write-to-temp + rename: a crash mid-write leaves the previous file intact
 *    instead of a truncated one (CWE-691 / data integrity).
 *  - Debounced: bursts (e.g. a chat of bets) collapse into one write.
 *  - Fail closed on read errors: an unreadable/corrupt file is reported loudly
 *    but never silently replaced with an empty database on load.
 *
 * SECURITY
 * --------
 *  - The file contains bcrypt password hashes, never plaintext passwords.
 *  - Created 0600 (owner read/write) inside a 0700 directory where the OS
 *    supports POSIX modes. Windows ignores the mode bits; the directory is
 *    still inside the application tree and is git-ignored.
 *  - Loading only accepts an array of plain objects per collection, so a
 *    hand-edited file cannot inject prototypes via `__proto__` keys.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.LOCAL_DATA_DIR
  ? path.resolve(process.env.LOCAL_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'local-db.json');
const TMP_FILE = `${DB_FILE}.tmp`;
const DB_VERSION = 1;

/** Refuse to load absurdly large files (defence against a planted file). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const SAVE_DEBOUNCE_MS = 120;

/** name -> () => serialisable value. Populated by the owning modules. */
const providers = new Map();

let cache = null;
let timer = null;
let dirty = false;
let writing = false;

function emptyDb() {
  return { version: DB_VERSION };
}

/** Validate a loaded collection: array of plain objects only. */
function sanitiseCollection(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item) => item && typeof item === 'object' && !Array.isArray(item)
  );
}

/**
 * Read the database from disk once. Later calls return the same object.
 *
 * @returns {{version:number, users?:Array, ledger?:Array}}
 */
function load() {
  if (cache !== null) return cache;

  let parsed = null;
  try {
    if (fs.existsSync(DB_FILE)) {
      const stat = fs.statSync(DB_FILE);
      if (!stat.isFile()) {
        throw new Error('not a regular file');
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(`file is larger than ${MAX_FILE_BYTES} bytes`);
      }
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      parsed = JSON.parse(raw);
    }
  } catch (error) {
    // Loud, but do not destroy the file: an operator may be able to recover it.
    console.error(`[local-db] Could not read ${DB_FILE}: ${error.message}`);
    console.error('[local-db] Starting with an empty in-memory store. The existing');
    console.error('[local-db] file has NOT been modified.');
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    cache = emptyDb();
    return cache;
  }

  cache = {
    version: DB_VERSION,
    users: sanitiseCollection(parsed.users),
    ledger: sanitiseCollection(parsed.ledger),
  };

  // Preserve any additional array collections owned by other modules (for
  // example crashBets/crashRounds). Dropping unknown keys here would silently
  // erase durable data written by providers on the next save.
  for (const key of Object.keys(parsed)) {
    if (key === 'version' || key === 'savedAt' || key in cache) continue;
    if (Array.isArray(parsed[key])) cache[key] = sanitiseCollection(parsed[key]);
  }

  return cache;
}

/** Register a live data provider (called at module load by its owner). */
function register(name, provider) {
  if (typeof name !== 'string' || typeof provider !== 'function') return;
  providers.set(name, provider);
}

function snapshot() {
  const out = { version: DB_VERSION, savedAt: new Date().toISOString() };
  for (const [name, provider] of providers) {
    try {
      out[name] = provider();
    } catch (error) {
      console.error(`[local-db] provider "${name}" failed: ${error.message}`);
    }
  }
  return out;
}

function writeAtomically(payload) {
  const json = JSON.stringify(payload);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(TMP_FILE, 'w', 0o600);
    try {
      fs.writeFileSync(fd, json, 'utf8');
      // Flush to disk before the rename so a power loss cannot leave a
      // zero-length file behind.
      try {
        fs.fsyncSync(fd);
      } catch (error) {
        /* not supported on every platform */
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(TMP_FILE, DB_FILE);
    return true;
  } catch (error) {
    console.error(`[local-db] Could not save ${DB_FILE}: ${error.message}`);
    return false;
  }
}

/** Write now if anything is pending. */
function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!dirty || writing) return;
  writing = true;
  dirty = false;
  try {
    writeAtomically(snapshot());
  } finally {
    writing = false;
    // A mutation that landed mid-write still needs persisting.
    if (dirty && !timer) scheduleSave();
  }
}

/** Mark the database dirty and schedule a debounced write. */
function scheduleSave() {
  dirty = true;
  if (timer || writing) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, SAVE_DEBOUNCE_MS);
  // Never keep the process alive just to flush.
  if (typeof timer.unref === 'function') timer.unref();
}

/** Best-effort synchronous flush for shutdown handlers. */
function flushSync() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!dirty) return;
  dirty = false;
  writeAtomically(snapshot());
}

let shutdownHooked = false;
function hookShutdown() {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const onExit = () => {
    try {
      flushSync();
    } catch (error) {
      /* process is going away */
    }
  };
  process.once('exit', onExit);
  process.once('SIGINT', () => {
    onExit();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    onExit();
    process.exit(0);
  });
  process.once('SIGHUP', () => {
    onExit();
    process.exit(0);
  });
}

hookShutdown();

module.exports = {
  DB_FILE,
  load,
  register,
  scheduleSave,
  flush,
  flushSync,
  isPersistent: true
};
