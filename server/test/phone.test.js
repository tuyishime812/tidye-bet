/**
 * Phone identity regression tests.
 *
 * Run:  node server/test/phone.test.js
 *
 * A phone number is a login identifier. These tests pin the rule that every
 * common way of typing the SAME Malawi number resolves to one canonical value,
 * so duplicate registration and "I cannot log in with my own number" bugs do
 * not come back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalisePhone,
  phoneLookupKeys,
  isValidPhone,
  duplicateField
} = require('../services/phone');

test('Malawi local, national and international forms normalise identically', () => {
  const expected = '+265991234567';
  for (const input of [
    '0991234567',
    '991234567',
    '265991234567',
    '+265991234567',
    '+265 991 234 567',
    '00265991234567',
    '0991-234-567'
  ]) {
    assert.equal(normalisePhone(input), expected, input);
  }
});

test('Airtel Malawi prefix (88) is handled the same way', () => {
  assert.equal(normalisePhone('0881234567'), '+265881234567');
  assert.equal(normalisePhone('881234567'), '+265881234567');
});

test('non-Malawi international numbers are not given a wrong country code', () => {
  assert.equal(normalisePhone('+14155552671'), '+14155552671');
  assert.equal(normalisePhone('14155552671'), '14155552671');
});

test('invalid input is rejected instead of silently accepted', () => {
  for (const bad of [
    '',
    '   ',
    'abc',
    '99',
    '9912345678901234', // 16 digits
    '+26599123',
    '0991 234 56x',
    null,
    undefined,
    {},
    [],
    1.5,
    NaN
  ]) {
    assert.equal(normalisePhone(bad), null, String(bad));
    assert.equal(isValidPhone(bad), false, String(bad));
  }
});

test('lookup keys cover every legacy representation of one subscriber', () => {
  const keys = phoneLookupKeys('991234567');
  for (const legacy of [
    '+265991234567',
    '265991234567',
    '0991234567',
    '991234567'
  ]) {
    assert.ok(keys.includes(legacy), `missing ${legacy}`);
  }
});

test('lookup keys for a legacy local number include the canonical form', () => {
  const keys = phoneLookupKeys('0991234567');
  assert.ok(keys.includes('+265991234567'));
  assert.ok(keys.includes('991234567'));
});

test('Postgres unique violations map to the colliding field', () => {
  assert.equal(
    duplicateField({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: 'Key (phone_number)=(+265991234567) already exists.'
    }),
    'phone'
  );
  assert.equal(
    duplicateField({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: 'Key (user_name)=(alice) already exists.'
    }),
    'name'
  );
  assert.equal(duplicateField({ code: '23505' }), 'unknown');
  assert.equal(duplicateField(new Error('network down')), null);
  assert.equal(duplicateField(null), null);
});
