#!/usr/bin/env node
/**
 * Create (or re-key) an admin account.
 *
 *   cd server
 *   node scripts/create-admin.js --username boss                 # random password
 *   node scripts/create-admin.js --username boss --role SUPERADMIN
 *   node scripts/create-admin.js --username boss --sql           # print SQL only
 *   node scripts/create-admin.js --username boss --password 'MyStr0ng-Passphrase'
 *
 * WHAT IT DOES
 *   Hashes the password with bcrypt (same algorithm the server verifies with)
 *   and either:
 *     * inserts/updates the row directly, when USE_SUPABASE=true and
 *       SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set; or
 *     * prints a ready-to-paste SQL statement for the Supabase SQL editor.
 *
 * The generated SQL is a case-insensitive UPSERT on `username_lower`, so running
 * it again for the same username re-keys that admin (which is exactly how you
 * reset a forgotten password from the Supabase dashboard).
 *
 * SECURITY: never prints the hash unless --sql is used, and only prints the
 * password when it generated one (so the operator can record it).
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const ROLES = ['ADMIN', 'SUPERADMIN'];
const MIN_PASSWORD = 12;

function usage() {
  console.log(`
Create or re-key a database admin account.

Usage:
  node scripts/create-admin.js --username <name> [options]

Options:
  --username <name>     (required) 3-32 chars: letters, numbers, . _ -
  --password <value>    Admin password (min ${MIN_PASSWORD}). Omit to auto-generate.
  --role <role>         ADMIN (default) or SUPERADMIN
  --display-name <name> Optional human-readable label
  --sql                 Only print the SQL for the Supabase SQL editor
  --help                Show this message
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--username':
      case '-u':
        out.username = next;
        i++;
        break;
      case '--password':
      case '-p':
        out.password = next;
        i++;
        break;
      case '--role':
        out.role = next;
        i++;
        break;
      case '--display-name':
        out.displayName = next;
        i++;
        break;
      case '--sql':
        out.sql = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        break;
    }
  }
  return out;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function die(message) {
  console.error(`\n[create-admin] ${message}\n`);
  console.error('Run "node scripts/create-admin.js --help" for usage.');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  const username = typeof args.username === 'string' ? args.username.trim() : '';
  if (!USERNAME_RE.test(username)) {
    die('A valid --username is required (3-32 chars: letters, numbers, . _ -).');
  }

  let password = typeof args.password === 'string' ? args.password : '';
  const generated = !password;
  if (generated) {
    // 12 random bytes -> 16 base64url chars; comfortably above the 12 floor.
    password = crypto.randomBytes(12).toString('base64url');
  }
  if (password.length < MIN_PASSWORD) {
    die(`Password must be at least ${MIN_PASSWORD} characters.`);
  }

  const role = String(args.role || 'ADMIN').toUpperCase();
  if (!ROLES.includes(role)) {
    die(`Role must be one of: ${ROLES.join(', ')}.`);
  }

  const hash = await bcrypt.hash(password, 12);

  const sql =
    'insert into admins (username, password_hash, role' +
    (args.displayName ? ', display_name' : '') +
    ', is_active)\n' +
    'values (' +
    [sqlLiteral(username), sqlLiteral(hash), sqlLiteral(role)]
      .concat(args.displayName ? [sqlLiteral(args.displayName)] : [])
      .concat(['true'])
      .join(', ') +
    ')\non conflict (username_lower) do update\n' +
    '  set password_hash = excluded.password_hash,\n' +
    '      role = excluded.role,\n' +
    '      is_active = true;';

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const dbConfigured = process.env.USE_SUPABASE === 'true' && url && serviceKey;

  if (args.sql || !dbConfigured) {
    console.log('\n-- Paste this into the Supabase SQL editor --\n');
    console.log(sql);
    console.log('');
    if (generated) console.log(`Generated password for "${username}": ${password}`);
    if (!dbConfigured && !args.sql) {
      console.log(
        '\n(No database connection configured, so the SQL above is provided instead.\n' +
          ' To insert directly, set USE_SUPABASE=true plus SUPABASE_URL and\n' +
          ' SUPABASE_SERVICE_ROLE_KEY in server/.env.)'
      );
    }
    return;
  }

  // Direct insert via the service-role key (bypasses RLS by design).
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await supabase
    .from('admins')
    .upsert(
      [{ username, password_hash: hash, role, is_active: true }],
      { onConflict: 'username_lower' }
    )
    .select('id, username, role, is_active')
    .single();

  if (error) {
    die(`Database write failed: ${error.message}`);
  }

  console.log(`\n✅ Admin "${data.username}" ready (role: ${data.role}, active: ${data.is_active}).`);
  if (generated) console.log(`   Generated password: ${password}`);
  console.log('   Sign in at /admin (or the admin API) with that username and password.\n');
}

main().catch((error) => die(error && error.stack ? error.stack : String(error)));
