/**
 * Canonical phone-number handling for account identity.
 *
 * A phone number is a login identifier, so the SAME subscriber must produce the
 * SAME stored value no matter how it was typed. Without this, `0991234567`,
 * `991234567`, `265991234567` and `+265991234567` would all be treated as four
 * different accounts - which lets one person register the same wallet several
 * times and makes a later login depend on which format they happen to use.
 *
 * This module never performs network I/O. It is deliberately pure so the
 * normalisation rules can be unit-tested (see test/phone.test.js).
 */

const MIN_DIGITS = 9;
const MAX_DIGITS = 15;

/** Remove the formatting characters people naturally type. */
function clean(value) {
  return String(value).trim().replace(/[\s\-().]/g, '');
}

/**
 * Normalise a phone number to a stable stored form.
 *
 * Malawian mobile numbers (the primary market) are canonicalised to
 * `+265<9 subscriber digits>`. Other international numbers keep their `+` when
 * supplied and are otherwise stored as digits so a number is never silently
 * given the wrong country code.
 *
 * @param {string|number} value
 * @returns {string|null} canonical value, or null when unusable
 */
function normalisePhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;

  let cleaned = clean(value);
  if (!cleaned) return null;

  // 00265... is the international dialling prefix form of +265...
  if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`;

  // Reject anything that is not digits with an optional leading plus.
  if (!/^\+?[0-9]+$/.test(cleaned)) return null;

  const digits = cleaned.replace(/^\+/, '');
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;

  // Malawi mobile in local, national or international form.
  if (/^0(88|99)[0-9]{7}$/.test(digits)) return `+265${digits.slice(1)}`;
  if (/^265(88|99)[0-9]{7}$/.test(digits)) return `+265${digits.slice(3)}`;
  if (/^(88|99)[0-9]{7}$/.test(digits)) return `+265${digits}`;

  return cleaned.startsWith('+') ? `+${digits}` : digits;
}

/**
 * Every stored representation that could belong to the same subscriber.
 *
 * Used for lookup only, so accounts created before normalisation existed are
 * still found. The canonical form is always the first entry.
 *
 * @param {string|number} value
 * @returns {string[]}
 */
function phoneLookupKeys(value) {
  const canonical = normalisePhone(value);
  if (!canonical) return [];

  const digits = canonical.replace(/^\+/, '');
  const keys = new Set([canonical, digits]);

  if (/^265(88|99)[0-9]{7}$/.test(digits)) {
    const local = digits.slice(3);
    keys.add(local);
    keys.add(`0${local}`);
    keys.add(`265${local}`);
    keys.add(`+265${local}`);
  } else if (/^0(88|99)[0-9]{7}$/.test(digits)) {
    const local = digits.slice(1);
    keys.add(local);
    keys.add(`265${local}`);
    keys.add(`+265${local}`);
  } else if (/^(88|99)[0-9]{7}$/.test(digits)) {
    keys.add(`0${digits}`);
    keys.add(`265${digits}`);
    keys.add(`+265${digits}`);
  } else if (canonical.startsWith('+')) {
    keys.add(digits);
  }

  return [...keys];
}

/** True when the value is a usable phone number. */
function isValidPhone(value) {
  return normalisePhone(value) !== null;
}

/**
 * Map a database unique-violation to the field that collided.
 *
 * Supabase/Postgres raises SQLSTATE 23505 and normally includes the constraint
 * name in `details`. Returning the field lets registration answer with a
 * specific 409 instead of a generic 500.
 *
 * @param {any} error
 * @returns {'phone'|'name'|'unknown'|null}
 */
function duplicateField(error) {
  if (!error) return null;
  const text = `${error.code || ''} ${error.message || ''} ${error.details || ''}`;
  if (error.code !== '23505' && !/duplicate key|unique constraint/i.test(text)) return null;
  if (/phone_number|users_phone/i.test(text)) return 'phone';
  if (/user_name|users_user_name/i.test(text)) return 'name';
  return 'unknown';
}

module.exports = {
  normalisePhone,
  phoneLookupKeys,
  isValidPhone,
  duplicateField
};
