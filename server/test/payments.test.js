/**
 * Ledger unit tests: the escrow (held) model behind withdrawals.
 *
 * Run:  node --test test/payments.test.js
 *
 * These lock down the disjoint-bucket model that SCHEMA.sql's apply_movement()
 * and services/ledger.js implement in parallel (memory mode must be a faithful
 * mirror of the Postgres mode - they enforce the same invariants):
 *
 *     placeHold:    balance -X, held +X   (money leaves the spendable balance)
 *     refundHold:   balance +X, held -X   (escrow returned to the player)
 *     releaseHold:  balance  0, held -X   (escrow consumed by a payout)
 *
 * The critical property: `balance` ALWAYS already excludes escrowed funds, so
 * a spend check anywhere in the app only ever needs `balance >= X`. There is
 * no `balance - held` that a future code path can forget.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomInt } = require('node:crypto');

const ledger = require('../services/ledger');
const memoryStore = require('../config/memoryStore');

let userSeed = 0;
function freshUser() {
  userSeed += 1;
  // Local mode persists users between runs (and enforce unique phones, like
  // Postgres). A random subscriber number keeps the fixture idempotent.
  const u = memoryStore.createUser({
    phone_number: `991${String(randomInt(0, 10_000_000)).padStart(7, '0')}`,
    user_name: `ledger${userSeed}${Date.now().toString(36)}`,
    password: 'test-only-password',
  });
  return u;
}

async function seedBalance(userId, minor) {
  const r = await ledger.credit({ userId, amountMinor: minor });
  assert.equal(r.ok, true, `seed credit failed: ${r.reason}`);
}

// ---------------------------------------------------------------------------
// The hold lifecycle
// ---------------------------------------------------------------------------

test('placeHold moves money out of balance into held', async () => {
  const user = freshUser();
  await seedBalance(user.id, 500000); // 5,000 MWK

  const hold = await ledger.placeHold({ userId: user.id, amountMinor: 100000 });
  assert.equal(hold.ok, true);
  assert.equal(hold.balance, 400000, 'balance is reduced by the hold');
  assert.equal(hold.held, 100000, 'held grows by the same amount');

  const avail = await ledger.getAvailable(user.id);
  assert.equal(avail.ok, true);
  assert.equal(avail.available, 400000, 'escrowed money is already excluded from available');
});

test('placeHold fails when the balance cannot cover it', async () => {
  const user = freshUser();
  await seedBalance(user.id, 50000); // 500 MWK

  const hold = await ledger.placeHold({ userId: user.id, amountMinor: 100000 });
  assert.equal(hold.ok, false);
  assert.equal(hold.reason, 'Insufficient balance');

  const avail = await ledger.getAvailable(user.id);
  assert.equal(avail.balance, 50000, 'nothing moved');
  assert.equal(avail.held, 0);
});

test('refundHold returns escrowed money to the balance', async () => {
  const user = freshUser();
  await seedBalance(user.id, 500000);
  await ledger.placeHold({ userId: user.id, amountMinor: 100000 });

  const refund = await ledger.refundHold({ userId: user.id, amountMinor: 100000 });
  assert.equal(refund.ok, true);
  assert.equal(refund.balance, 500000, 'balance is fully restored');
  assert.equal(refund.held, 0, 'held is cleared');
});

test('releaseHold consumes escrow without touching balance (payout settled)', async () => {
  const user = freshUser();
  await seedBalance(user.id, 500000);
  await ledger.placeHold({ userId: user.id, amountMinor: 100000 });

  // A payout was sent to the player. The money already left `balance` when the
  // hold was placed; crediting balance here would pay it twice.
  const release = await ledger.releaseHold({ userId: user.id, amountMinor: 100000 });
  assert.equal(release.ok, true);
  assert.equal(release.balance, 400000, 'balance is NOT credited on payout');
  assert.equal(release.held, 0, 'held is consumed');

  const avail = await ledger.getAvailable(user.id);
  assert.equal(avail.available, 400000);
});

test('releaseHold cannot consume more than is held', async () => {
  const user = freshUser();
  await seedBalance(user.id, 500000);
  await ledger.placeHold({ userId: user.id, amountMinor: 100000 });

  const release = await ledger.releaseHold({ userId: user.id, amountMinor: 200000 });
  assert.equal(release.ok, false);
  assert.equal(release.reason, 'Invalid hold release');

  const avail = await ledger.getAvailable(user.id);
  assert.equal(avail.balance, 400000);
  assert.equal(avail.held, 100000, 'held is untouched after the failed release');
});

// ---------------------------------------------------------------------------
// Ledger rows: shape and vocabulary
// ---------------------------------------------------------------------------

test('a payout ledger row is delta 0 with a negative hold_delta', async () => {
  const user = freshUser();
  await seedBalance(user.id, 500000);
  await ledger.placeHold({ userId: user.id, amountMinor: 100000, refType: 'withdrawal', refId: 'wd_1' });
  await ledger.releaseHold({ userId: user.id, amountMinor: 100000, refType: 'withdrawal', refId: 'wd_1' });

  const { entries } = await ledger.getLedger(user.id, 20);
  const paid = entries.find((e) => e.reason === 'WITHDRAWAL_PAID');
  assert.ok(paid, 'a WITHDRAWAL_PAID row exists');
  assert.equal(paid.delta, 0, 'balance bucket did not move');
  assert.equal(paid.hold_delta, -1000, 'escrow bucket consumed 1,000 MWK');
  assert.equal(paid.ref_id, 'wd_1');
});

test('credit() defaults to DEPOSIT and refuses withdrawal-shaped misuse', async () => {
  const user = freshUser();
  // No reason passed: the row must be a DEPOSIT, not whatever a confused caller
  // was doing elsewhere.
  const r = await ledger.credit({ userId: user.id, amountMinor: 1000 });
  assert.equal(r.ok, true);

  const { entries } = await ledger.getLedger(user.id, 10);
  assert.equal(entries[0].reason, 'DEPOSIT');

  // credit() is a balance-only helper: asking it to move escrow must fail the
  // shape check, not silently create a malformed ledger row.
  const bad = await ledger.credit({ userId: user.id, amountMinor: 1000, reason: 'WITHDRAWAL_HOLD' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /must move X out of balance/);
});

test('credit() honours an explicit non-deposit reason (bet payout)', async () => {
  const user = freshUser();
  const r = await ledger.credit({
    userId: user.id, amountMinor: 100000, reason: 'BET_PAYOUT', refType: 'bet', refId: 'fb_1'
  });
  assert.equal(r.ok, true);
  const { entries } = await ledger.getLedger(user.id, 10);
  assert.equal(entries[0].reason, 'BET_PAYOUT');
});

test('mis-shaped hold movements are refused before they touch storage', async () => {
  const user = freshUser();
  await seedBalance(user.id, 500000);

  // WITHDRAWAL_HOLD must be balance -X, held +X. Balance +hold is a forger.
  const bad1 = await ledger.moveBalance({
    userId: user.id, amountMinor: 100000, holdMinor: 100000, reason: 'WITHDRAWAL_HOLD'
  });
  assert.equal(bad1.ok, false);
  assert.match(bad1.reason, /must move X out of balance/);

  // WITHDRAWAL_PAID must not touch balance.
  const bad2 = await ledger.moveBalance({
    userId: user.id, amountMinor: -100000, holdMinor: -100000, reason: 'WITHDRAWAL_PAID'
  });
  assert.equal(bad2.ok, false);
  assert.match(bad2.reason, /must consume held/);

  // A non-withdrawal reason may never touch held.
  const bad3 = await ledger.moveBalance({
    userId: user.id, amountMinor: -100000, holdMinor: 100000, reason: 'BET_STAKE'
  });
  assert.equal(bad3.ok, false);
  assert.match(bad3.reason, /only withdrawal reasons/);

  // Unknown reason is refused outright.
  const bad4 = await ledger.moveBalance({
    userId: user.id, amountMinor: -100000, holdMinor: 0, reason: 'FREE_MONEY'
  });
  assert.equal(bad4.ok, false);
  assert.equal(bad4.reason, 'Invalid reason');
});

// ---------------------------------------------------------------------------
// Concurrency: the double-spend that the ledger exists to prevent
// ---------------------------------------------------------------------------

test('concurrent debits cannot drive a balance below zero', async () => {
  const user = freshUser();
  await seedBalance(user.id, 100000); // 1,000 MWK

  // 25 concurrent debits of 200 MWK each against 1,000 MWK. Exactly 5 may
  // succeed. If the read-check-write interleaves (the old bug), more succeed
  // and the balance goes negative.
  const attempts = Array.from({ length: 25 }, () =>
    ledger.debit({ userId: user.id, amountMinor: 20000, reason: 'BET_STAKE' })
  );
  const results = await Promise.all(attempts);
  const ok = results.filter((r) => r.ok === true).length;

  assert.equal(ok, 5, `exactly 5 of 25 debits may succeed (got ${ok})`);

  const avail = await ledger.getAvailable(user.id);
  assert.equal(avail.balance, 0, 'balance is exactly zero, never negative');
});

test('the in-memory ledger reconciles to the stored balance', async () => {
  const user = freshUser();
  await seedBalance(user.id, 500000); // deposit +5,000
  await ledger.placeHold({ userId: user.id, amountMinor: 100000 }); // -1,000 held
  await ledger.refundHold({ userId: user.id, amountMinor: 100000 }); // +1,000
  await ledger.debit({ userId: user.id, amountMinor: 5000, reason: 'BET_STAKE' }); // -50
  await ledger.credit({ userId: user.id, amountMinor: 200000 }); // +2,000

  const rec = ledger.reconcileMemory(user.id);
  const avail = await ledger.getAvailable(user.id);

  assert.equal(rec.balanceMinor, avail.balance, 'ledger delta sum equals stored balance');
  assert.equal(rec.heldMinor, avail.held, 'ledger hold sum equals stored held');
  assert.equal(rec.rows, 5, 'every movement produced exactly one row');
});