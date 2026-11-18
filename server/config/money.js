/**
 * Money primitives — the ONLY place currency is converted.
 *
 * WHY THIS EXISTS
 * ---------------
 * Money conversion was previously duplicated across the codebase, which is how
 * the Critical payout bug (C-3 in SECURITY_REPORT.md) happened: minor units
 * (x100) were multiplied against basis points (x100) with no scale conversion,
 * paying 100x the stake. Every feature that touches money now goes through this
 * module so that class of bug has one definition instead of N.
 *
 * CONVENTIONS (fixed, do not vary per feature)
 * -------------------------------------------
 *   - Amounts are held as INTEGER MINOR UNITS. 1 MWK = 100 minor.
 *   - No floating point is ever used for arithmetic on money. Parsing goes
 *     through toMinor(), which is exact and rejects anything ambiguous.
 *   - Odds are DECIMAL multipliers (2.50 means 2.50x) on the wire, and are
 *     multiplied by dividing by 100 rather than by the caller converting units.
 *
 * CWE-20 (Improper Input Validation): toMinor() deliberately does NOT use blind
 * Number() coercion, which would turn null into 0, true into 1 and [500] into
 * 500 — all of which are attacker-controlled type confusion at a trust boundary.
 */
const MINOR_PER_MAJOR = 100;

/** Strict decimal pattern. Rejects '', ' ', '1e3', '0x10', '12abc', '.5', '-1'. */
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** Above this, arithmetic risks precision loss; nothing legitimate is this big. */
const MAX_MAJOR = 1e12;

/**
 * Convert a wire amount (MWK) to integer minor units.
 * @returns {number|null} null when the input is not a valid money amount.
 */
function toMinor(amount) {
  let n;

  if (typeof amount === 'number') {
    n = amount;
  } else if (typeof amount === 'string') {
    const trimmed = amount.trim();
    if (!DECIMAL_RE.test(trimmed)) return null;
    n = Number(trimmed);
  } else {
    // null, undefined, boolean, array, object, bigint, symbol -> reject.
    return null;
  }

  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  if (n > MAX_MAJOR) return null;

  // Math.round on n*100 can drift for values like 1.005; re-parse the decimal
  // string when we have one so the result is always what was written.
  if (typeof amount === 'string') {
    const [whole, frac = ''] = amount.trim().split('.');
    return Number(whole) * MINOR_PER_MAJOR + Number((frac + '00').slice(0, 2));
  }
  return Math.round(n * MINOR_PER_MAJOR);
}

/**
 * Convert integer minor units back to a wire amount (MWK).
 * Never throws or returns NaN — display paths must not be able to crash a page.
 */
function fromMinor(minor) {
  const n = Number(minor);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / MINOR_PER_MAJOR;
}

/** Format for display/logging. */
function formatMinor(minor) {
  return `${fromMinor(minor).toFixed(2)} MWK`;
}

/**
 * Multiply a MINOR amount by a decimal odds multiplier, returning MINOR units.
 *
 * The one place stake x odds is computed. Getting the scale wrong here is the
 * C-3 bug, so it is centralised and asserted:
 *
 *     stakeMinor (x100 already applied) * (odds / 1)
 *   = stakeMinor * odds
 *
 * Note there is NO second x100 to remove: `odds` is already a plain decimal
 * multiplier such as 2.50. The earlier code stored odds as basis points and
 * multiplied them in raw, which is where the 100x came from.
 *
 * @param {number} stakeMinor integer minor units
 * @param {number} odds decimal multiplier, e.g. 2.5
 * @returns {number} integer minor units
 */
function multiplyByOdds(stakeMinor, odds) {
  if (!Number.isInteger(stakeMinor) || stakeMinor <= 0) {
    throw new Error('multiplyByOdds: stakeMinor must be a positive integer');
  }
  const o = Number(odds);
  if (!Number.isFinite(o) || o <= 1) {
    throw new Error('multiplyByOdds: odds must be a finite multiplier > 1');
  }
  // Guard against an absurd line: 1000.00x is far beyond any real sportsbook.
  if (o > 1000) throw new Error('multiplyByOdds: odds exceed the 1000.00x ceiling');

  const result = Math.round(stakeMinor * o);
  if (!Number.isInteger(result) || result < stakeMinor) {
    throw new Error('multiplyByOdds: produced an invalid payout');
  }
  return result;
}

/**
 * Apply a percentage fee to a MINOR amount, rounding in the player's favour
 * (fee rounds up, so the house never under-collects by a fraction of a unit).
 */
function feeFromMinor(amountMinor, percent) {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error('feeFromMinor: amountMinor must be a non-negative integer');
  }
  const p = Number(percent);
  if (!Number.isFinite(p) || p < 0 || p >= 100) {
    throw new Error('feeFromMinor: percent must be within [0, 100)');
  }
  const fee = Math.ceil((amountMinor * p) / 100);
  return fee;
}

module.exports = {
  MINOR_PER_MAJOR,
  toMinor,
  fromMinor,
  formatMinor,
  multiplyByOdds,
  feeFromMinor
};