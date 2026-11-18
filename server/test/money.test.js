/**
 * Money-math regression tests.
 *
 * Run:  node server/test/money.test.js
 *
 * Guards the canonical money primitives in server/config/money.js, including the
 * C-3 regression: multiplying minor units by a mismatched odds scale (basis
 * points) paid 100x the correct amount. Payouts must be computed as
 * stakeMinor * odds (decimal multiplier), never as stakeMinor * oddsMinor.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../config/money');

// ---------------------------------------------------------------------------
// Minor-unit conversion
// ---------------------------------------------------------------------------

test('toMinor converts MWK to integer minor units', () => {
  assert.equal(money.toMinor(1), 100);
  assert.equal(money.toMinor(1000), 100000);
  assert.equal(money.toMinor(10.5), 1050);
  assert.equal(money.toMinor(0.1 + 0.2), 30);
  assert.ok(Number.isInteger(money.toMinor(123.456)));
});

test('toMinor rejects junk instead of coercing it to a value', () => {
  assert.equal(money.toMinor('abc'), null);
  assert.equal(money.toMinor(undefined), null);
  assert.equal(money.toMinor(NaN), null);
  assert.equal(money.toMinor(Infinity), null);
  assert.equal(money.toMinor(-Infinity), null);
});

test('toMinor refuses the Number()-coercion type-confusion cases', () => {
  assert.equal(money.toMinor(null), null, 'null must not become 0');
  assert.equal(money.toMinor(''), null, 'empty string must not become 0');
  assert.equal(money.toMinor('   '), null, 'whitespace must not become 0');
  assert.equal(money.toMinor(true), null, 'boolean must not become 1');
  assert.equal(money.toMinor(false), null, 'boolean must not become 0');
  assert.equal(money.toMinor([]), null, 'empty array must not become 0');
  assert.equal(money.toMinor([500]), null, 'array must not become 500');
  assert.equal(money.toMinor({}), null);
  assert.equal(money.toMinor({ valueOf: () => 500 }), null, 'no valueOf tricks');
  assert.equal(money.toMinor(() => 500), null);
  assert.equal(money.toMinor(500n), null, 'bigint must not become 500');
});

test('toMinor rejects Number()-lax string forms', () => {
  assert.equal(money.toMinor('1e3'), null, 'exponent form rejected');
  assert.equal(money.toMinor('0x10'), null, 'hex rejected');
  assert.equal(money.toMinor('12abc'), null, 'trailing junk rejected');
  assert.equal(money.toMinor('Infinity'), null);
  assert.equal(money.toMinor('-100'), null, 'negative money rejected');
  assert.equal(money.toMinor('1.2.3'), null);
  assert.equal(money.toMinor('.5'), null, 'require a leading digit');
});

test('toMinor accepts legitimate numeric strings', () => {
  assert.equal(money.toMinor('1000'), 100000);
  assert.equal(money.toMinor('10.50'), 1050);
  assert.equal(money.toMinor(' 250 '), 25000, 'surrounding whitespace is fine');
  assert.equal(money.toMinor('0.01'), 1);
});

test('toMinor rejects magnitudes that would overflow downstream money math', () => {
  assert.equal(money.toMinor(1e13), null);
  assert.equal(money.toMinor('999999999999999'), null);
  assert.equal(money.toMinor(-1e13), null);
});

test('fromMinor never returns NaN for junk input', () => {
  assert.equal(money.fromMinor('abc'), 0);
  assert.equal(money.fromMinor(undefined), 0);
  assert.equal(money.fromMinor(null), 0);
  assert.equal(money.fromMinor(NaN), 0);
  assert.equal(money.fromMinor(Infinity), 0);
});

test('fromMinor is the exact inverse of toMinor for representable amounts', () => {
  for (const amount of [1, 10.5, 99.99, 1000, 12345.67]) {
    assert.equal(money.fromMinor(money.toMinor(amount)), amount);
  }
});

// ---------------------------------------------------------------------------
// Payout math - C-3 regression
// ---------------------------------------------------------------------------

test('multiplyByOdds returns exactly stake x odds (decimal multiplier)', () => {
  // 1000 MWK at 2.06x must return 2060 MWK = 206000 minor.
  const stakeMinor = money.toMinor(1000); // 100000
  const result = money.multiplyByOdds(stakeMinor, 2.06);
  assert.equal(result, 206000);

  // The historical bug: stakeMinor * oddsBasisPoints = 100000 * 206 = 20,600,000
  assert.notEqual(result, stakeMinor * 206);
});

test('payout is not 100x the stake for a range of realistic odds', () => {
  const stakeMinor = money.toMinor(1000);
  for (const odds of [1.01, 1.5, 2.0, 2.48, 4.5, 15.0, 50.0, 101.0]) {
    const retMinor = money.multiplyByOdds(stakeMinor, odds);
    const ret = money.fromMinor(retMinor);
    assert.equal(ret, Math.round(1000 * odds) / 1, `odds ${odds}`);
    assert.equal(ret - 1000, Math.round(1000 * (odds - 1)), `profit at odds ${odds}`);
  }
});

test('payout stays an integer at a large stake', () => {
  const stakeMinor = money.toMinor(10000);
  const retMinor = money.multiplyByOdds(stakeMinor, 3.33);
  assert.ok(Number.isInteger(retMinor));
  assert.equal(money.fromMinor(retMinor), 33300);
});

test('multiplyByOdds rejects invalid inputs and mismatched units', () => {
  assert.throws(() => money.multiplyByOdds(0, 2.0));
  assert.throws(() => money.multiplyByOdds(-500, 2.0));
  assert.throws(() => money.multiplyByOdds(10.5, 2.0));
  assert.throws(() => money.multiplyByOdds(NaN, 2.0));
  assert.throws(() => money.multiplyByOdds(1000, 1));
  assert.throws(() => money.multiplyByOdds(1000, 0));
  assert.throws(() => money.multiplyByOdds(1000, -2));
  assert.throws(() => money.multiplyByOdds(1000, Infinity));
  assert.throws(() => money.multiplyByOdds(1000, 1001), /ceiling/i);
});

// ---------------------------------------------------------------------------
// Fee helper
// ---------------------------------------------------------------------------

test('feeFromMinor applies percentage and rounds up', () => {
  assert.equal(money.feeFromMinor(10000, 1.5), 150);
  assert.equal(money.feeFromMinor(10001, 1.5), 151);
  assert.equal(money.feeFromMinor(10000, 0), 0);
});
