/**
 * Money + payments unit tests.
 *
 * Run:  node server/test/money-payments.test.js
 *
 * These lock down the unit contract that produced the Critical C-3 payout bug,
 * plus the validation gates on the deposit settlement path and payout
 * destination.
 *
 * UNIT CONTRACT (the thing that keeps getting confused):
 *   - `deposit.amount` in the DB is MAJOR units (MWK, NUMERIC(14,2)).
 *   - Everything in application code is MINOR units (integer, x100).
 *   - `gatewayAmountMinor` is ALREADY minor units.
 * A comparison that forgets this rejects every real payment or, far worse,
 * accepts a 100x mismatch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../config/money');
const payout = require('../services/payout');

// ---------------------------------------------------------------------------
// money.js
// ---------------------------------------------------------------------------

test('toMinor converts MWK to integer minor units', () => {
  assert.equal(money.toMinor(50), 5000);
  assert.equal(money.toMinor(1000), 100000);
  assert.equal(money.toMinor('10.50'), 1050);
  assert.equal(money.toMinor(0.07), 7);
  assert.ok(Number.isInteger(money.toMinor('123.45')));
});

test('toMinor is exact for decimal strings (no float drift)', () => {
  // '8.20' * 100 === 819.9999999999999 in float arithmetic; the string path
  // must not inherit that.
  assert.equal(money.toMinor('8.20'), 820);
  assert.equal(money.toMinor('0.1'), 10);
  assert.equal(money.toMinor('1.1'), 110);
  assert.equal(money.toMinor('70.7'), 7070);
});

test('toMinor rejects sub-cent precision rather than rounding it', () => {
  // MWK has no subunit. A client sending 3 decimals is malformed input, and
  // silently rounding it would let '1.005' and '1.004' both mean 1.00.
  assert.equal(money.toMinor('1.005'), null);
  assert.equal(money.toMinor('0.001'), null);
  assert.equal(money.toMinor('10.555'), null);
});

test('toMinor rejects type confusion and lax strings', () => {
  for (const bad of [null, undefined, true, false, [], [500], {}, '', '  ', 'abc',
                     '1e3', '0x10', '12abc', '-5', '.5', 'Infinity', NaN]) {
    assert.equal(money.toMinor(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test('fromMinor never returns NaN', () => {
  for (const bad of ['abc', null, undefined, NaN, Infinity]) {
    assert.equal(money.fromMinor(bad), 0);
  }
  assert.equal(money.fromMinor(5000), 50);
});

test('multiplyByOdds returns exactly stake x odds in minor units', () => {
  // This is the C-3 regression. The old code multiplied minor units by basis
  // points and paid 100x.
  assert.equal(money.multiplyByOdds(100000, 2.06), 206000);
  assert.equal(money.multiplyByOdds(100000, 1.01), 101000);
  assert.equal(money.multiplyByOdds(5000, 50), 250000);
  // Profit equals stake x (odds - 1).
  assert.equal(money.multiplyByOdds(100000, 2.06) - 100000, 106000);
});

test('multiplyByOdds refuses a payout below the stake', () => {
  assert.throws(() => money.multiplyByOdds(100000, 1));
  assert.throws(() => money.multiplyByOdds(100000, 0.5));
  assert.throws(() => money.multiplyByOdds(100000, 0));
  assert.throws(() => money.multiplyByOdds(-100, 2));
  assert.throws(() => money.multiplyByOdds(100.5, 2), /positive integer/);
});

test('multiplyByOdds refuses an implausible line', () => {
  assert.throws(() => money.multiplyByOdds(100000, 1001), /ceiling/);
  assert.doesNotThrow(() => money.multiplyByOdds(100000, 1000));
});

test('feeFromMinor rounds up so the house never under-collects', () => {
  assert.equal(money.feeFromMinor(100000, 2), 2000);
  assert.equal(money.feeFromMinor(101, 2), 3); // 2.02 -> 3, rounds up
  assert.equal(money.feeFromMinor(100000, 0), 0);
  assert.throws(() => money.feeFromMinor(100000, 100));
  assert.throws(() => money.feeFromMinor(100000, -1));
});

// ---------------------------------------------------------------------------
// Payout destination
// ---------------------------------------------------------------------------

test('Malawi mobile numbers are accepted and normalised', () => {
  const good = [
    ['991234567', '+265991234567'],
    ['881234567', '+265881234567'],
    ['+265991234567', '+265991234567'],
    ['265991234567', '+265991234567'],
    ['00265991234567', '+265991234567'],
    ['991 234 567', '+265991234567'],
    ['991-234-567', '+265991234567']
  ];
  for (const [input, expected] of good) {
    const r = payout.validateDestination(input, 'mpamba');
    assert.equal(r.ok, true, `${input} should be valid`);
    assert.equal(r.normalised, expected);
  }
});

test('non-Malawi and malformed destinations are refused', () => {
  const bad = ['123', '777123456', '+1234567890', '9912345670000', 'abc', '', null, true, [], {}];
  for (const input of bad) {
    const r = payout.validateDestination(input, 'mpamba');
    assert.equal(r.ok, false, `${JSON.stringify(input)} must be refused`);
  }
});

test('only supported payout methods are accepted', () => {
  assert.equal(payout.validateDestination('991234567', 'airtel_money').ok, true);
  for (const method of ['bitcoin', 'cash', '', null, 'MPAMBA']) {
    const r = payout.validateDestination('991234567', method);
    assert.equal(r.ok, false, `method ${method} must be refused`);
  }
});

test('payout refuses to claim success when unconfigured', () => {
  // The whole point: an unconfirmed transfer must never mark a withdrawal PAID.
  return payout.sendToWallet({
    amountMinor: 100000,
    phoneNumber: '991234567',
    method: 'mpamba',
    reference: 'test'
  }).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.code, payout.NOT_CONFIGURED);
    assert.equal(r.retryable, false);
  });
});