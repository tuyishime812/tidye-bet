/**
 * Payout destination validation + a deliberately fail-closed transport.
 *
 * WHY THIS IS DELIBERATELY PARANOID
 * ---------------------------------
 * Sending money to a mobile-money wallet is IRREVERSIBLE and cannot be rolled
 * back. That is a fundamentally different risk class from crediting a balance:
 * a duplicate credit is a support ticket, a duplicate payout is real money gone.
 *
 * NO AUTOMATED PAYOUT CHANNEL IS WIRED UP
 * ---------------------------------------
 * Deposits run through PayChangu hosted checkout, which this integration uses
 * for collecting money only. There is no configured payout API, so
 * sendToWallet() ALWAYS refuses with PAYOUT_NOT_CONFIGURED and the withdrawal
 * stays PENDING with the funds held. An operator settles it manually by sending
 * the money from the PayChangu dashboard and calling
 * POST /api/payments/admin/withdrawals/:id/approve with
 * `{ manual: true, reference }`. That endpoint refuses to mark anything PAID
 * without either a positive gateway confirmation or that explicit manual flag.
 */

/** Payout methods this platform supports. Matches the CHECK in SCHEMA.sql. */
const METHODS = Object.freeze(['mpamba', 'airtel_money']);

/**
 * Reason a payout could not be sent. Distinguishes "not configured" from
 * "configured but the gateway refused", because those need different operator
 * responses.
 */
const NOT_CONFIGURED = 'PAYOUT_NOT_CONFIGURED';
const GATEWAY_ERROR = 'PAYOUT_GATEWAY_ERROR';

/**
 * Is a real, credentialed automatic payout channel available?
 *
 * Always false: no payout transport is configured. Kept as a function so the
 * route, /config and /methods all read the same single source of truth.
 */
function isPayoutConfigured() {
  return false;
}

/**
 * Validate a payout destination before any money is moved.
 *
 * CWE-20. The phone number is the ONLY thing standing between a valid
 * withdrawal and money sent to the wrong person, so it is validated strictly
 * and normalised to E.164-ish form (+<country><subscriber>).
 *
 * @returns {{ok:boolean, normalised?:string, reason?:string}}
 */
function validateDestination(phoneNumber, method) {
  if (!METHODS.includes(method)) {
    return { ok: false, reason: 'Unsupported payout method' };
  }
  if (typeof phoneNumber !== 'string') {
    return { ok: false, reason: 'Invalid phone number' };
  }

  // Strip spaces, dashes, parentheses and a leading 00 international prefix.
  let cleaned = phoneNumber.trim().replace(/[\s\-()]/g, '');
  cleaned = cleaned.replace(/^00/, '+');

  // Accepted forms:
  //   +265991234567  (12 digits: +265 + 9)
  //   265991234567   (12 digits, no +)
  //   991234567      (local 9-digit subscriber number)
  // Malawian mobile subscriber numbers are 9 digits beginning 88 or 99.
  let local = null;
  if (/^\+265[0-9]{9}$/.test(cleaned)) {
    local = cleaned.slice(4);
  } else if (/^265[0-9]{9}$/.test(cleaned)) {
    local = cleaned.slice(3);
  } else if (/^[0-9]{9}$/.test(cleaned)) {
    local = cleaned;
  }

  if (!local || !/^(88|99)[0-9]{7}$/.test(local)) {
    return { ok: false, reason: 'Phone number must be a valid Malawi mobile number' };
  }

  return { ok: true, normalised: `+265${local}` };
}

/**
 * Send money to a mobile-money wallet.
 *
 * CONTRACT: return ok:true ONLY if a gateway positively confirmed the transfer.
 * Any uncertainty - no configured channel, timeout, transport error, ambiguous
 * body - returns ok:false so the withdrawal stays PENDING and the funds stay
 * held for a human to resolve.
 *
 * @returns {Promise<{ok:boolean, gatewayRef?:string, code?:string, reason?:string,
 *                    retryable?:boolean}>}
 */
async function sendToWallet({ amountMinor, phoneNumber, method } = {}) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return { ok: false, code: GATEWAY_ERROR, retryable: false, reason: 'Invalid payout amount' };
  }

  const destination = validateDestination(phoneNumber, method);
  if (!destination.ok) {
    return { ok: false, code: GATEWAY_ERROR, retryable: false, reason: destination.reason };
  }

  // Fail closed: no payout transport exists, so never claim the money was sent.
  return {
    ok: false,
    code: NOT_CONFIGURED,
    retryable: false,
    reason:
      'Automatic payout is not configured. Send the money from the PayChangu ' +
      'dashboard, then approve the withdrawal with a manual reference.'
  };
}

module.exports = {
  METHODS,
  NOT_CONFIGURED,
  GATEWAY_ERROR,
  isPayoutConfigured,
  validateDestination,
  sendToWallet
};
