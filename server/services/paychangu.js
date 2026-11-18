/**
 * PayChangu hosted checkout (Malawi: MPamba / Airtel Money / cards).
 *
 * WHY THIS EXISTS
 * ---------------
 * A hosted checkout is how a betting site takes deposits. PayChangu drives the
 * whole flow:
 *
 *   1. We create a PENDING deposit and a unique `tx_ref`.
 *   2. We ask PayChangu to initialise a checkout for that reference.
 *   3. The player is redirected to PayChangu, picks MPamba/Airtel/card and pays.
 *   4. PayChangu redirects the player back to us.
 *   5. We NEVER trust the redirect: we call verify-payment/{tx_ref} and only
 *      credit when the gateway confirms the reference, currency and an amount
 *      >= the amount we recorded.
 *
 * SECURITY NOTES
 * --------------
 * - Settlement is driven only by verify-payment/{tx_ref}. A forged browser
 *   redirect cannot mint a deposit: the gateway must confirm the reference,
 *   currency and an amount >= the amount we recorded.
 * - All comparisons against the gateway use integer minor units (see
 *   config/money.js), never floating point.
 * - Secret keys are read from the environment at call time and are never logged.
 */

const axios = require('axios');
const { toMinor, fromMinor } = require('../config/money');

const BASE_URL = 'https://api.paychangu.com';
const DEFAULT_TIMEOUT_MS = 15_000;

const OPERATOR_ALIASES = {
  airtel_money: ['airtel'],
  mpamba: ['tnm', 'mpamba']
};

/**
 * Reject blank values AND the placeholders committed in .env.example. Treating
 * `sec-your-secret-key-here` as "configured" would advertise checkout to players
 * and then fail every payment at the gateway.
 */
function isUsableSecret(value) {
  const s = String(value || '').trim();
  if (s.length < 8) return false;
  return !/your[-_]?secret|change[-_]?me|placeholder|example/i.test(s);
}

function secretKey() {
  const value = process.env.PAYCHANGU_SECRET_KEY || '';
  return isUsableSecret(value) ? value : '';
}

function isConfigured() {
  return Boolean(secretKey());
}

function timeoutMs() {
  const n = Number(process.env.PAYCHANGU_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function normalizeMsisdn(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  // PayChangu mobile-money expects a 9-digit local number.
  if (/^265(\d{9})$/.test(digits)) return digits.slice(3);
  if (/^0(\d{9})$/.test(digits)) return digits.slice(1);
  if (/^\d{9}$/.test(digits)) return digits;
  return null;
}

async function listMobileMoneyOperators(opts = {}) {
  const http = opts.http || axios;
  if (!isConfigured()) return { ok: false, reason: 'not_configured', operators: [] };
  const candidates = ['/mobile-money', '/mobile-money/operators'];
  for (const path of candidates) {
    try {
      const res = await http.get(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${secretKey()}`, Accept: 'application/json' },
        timeout: timeoutMs()
      });
      const body = res && res.data;
      const list = Array.isArray(body && body.data) ? body.data : Array.isArray(body) ? body : [];
      const operators = list
        .map((o) => ({
          refId: String(o.ref_id || o.operator_ref_id || o.id || ''),
          name: String(o.name || o.short_code || '').toLowerCase(),
          shortCode: String(o.short_code || '').toLowerCase(),
          raw: o
        }))
        .filter((o) => o.refId);
      if (operators.length) return { ok: true, operators };
    } catch (_) {
      // try next
    }
  }
  return { ok: false, reason: 'operators_unavailable', operators: [] };
}

function pickOperator(operators, method) {
  const aliases = OPERATOR_ALIASES[String(method || '').toLowerCase()] || [];
  if (!aliases.length || !Array.isArray(operators)) return null;
  return (
    operators.find((o) => aliases.some((a) => o.name.includes(a) || o.shortCode.includes(a))) || null
  );
}

/**
 * Initialise a direct mobile-money charge (push prompt to phone).
 * Falls back to caller to use hosted checkout if unavailable.
 */
async function initializeMobileMoney(params, opts = {}) {
  const http = opts.http || axios;
  const { amountMinor, txRef, phone, method, email, firstName, lastName, meta } = params || {};

  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return { ok: false, reason: 'invalid_amount' };
  if (!txRef || typeof txRef !== 'string' || txRef.length > 128) return { ok: false, reason: 'invalid_reference' };
  const mobile = normalizeMsisdn(phone);
  if (!mobile) return { ok: false, reason: 'invalid_phone' };

  const ops = await listMobileMoneyOperators({ http });
  if (!ops.ok) {
    return { ok: false, reason: ops.reason || 'operators_unavailable' };
  }
  const operator = pickOperator(ops.operators, method);
  if (!operator) {
    return { ok: false, reason: 'operator_not_supported' };
  }

  const payload = {
    mobile,
    mobile_money_operator_ref_id: operator.refId,
    amount: String(fromMinor(amountMinor)),
    currency: 'MWK',
    charge_id: txRef,
    tx_ref: txRef,
    email: email || undefined,
    first_name: firstName || undefined,
    last_name: lastName || undefined
  };
  if (Array.isArray(meta) && meta.length) payload.meta = meta;
  else if (meta && typeof meta === 'object') {
    const entries = Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (entries.length) payload.meta = [Object.fromEntries(entries.map(([k, v]) => [k, String(v)]))];
  }

  const endpoints = ['/mobile-money/payments/initialize'];
  let lastError = null;
  for (const path of endpoints) {
    try {
      const res = await http.post(`${BASE_URL}${path}`, payload, {
        headers: {
          Authorization: `Bearer ${secretKey()}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: timeoutMs()
      });
      const body = res && res.data;
      const statusStr = String((body && body.status) || '').toLowerCase();
      const data = (body && body.data) || {};
      const ok = body && (body.status === 'success' || body.status === true || statusStr === 'success' || statusStr === 'pending');
      if (!ok) {
        console.error('[paychangu] mobile-money initialize rejected', {
          path,
          status: res && res.status,
          bodyStatus: body && body.status,
          message: body && (body.message || data.message)
        });
        lastError = {
          ok: false,
          reason: 'gateway_rejected',
          status: res && res.status,
          message: body && (body.message || data.message)
        };
        continue;
      }
      return {
        ok: true,
        txRef,
        mode: 'mobile_money',
        message: (body && body.message) || (data && data.message) || 'Payment prompt sent to your phone.',
        status: res && res.status
      };
    } catch (error) {
      const status = error && error.response && error.response.status;
      const body = error && error.response && error.response.data;
      const detail = {
        path,
        status,
        code: error && error.code,
        message: error && error.message,
        gatewayMessage: body && (body.message || (body.data && body.data.message) || body.status)
      };
      console.error('[paychangu] mobile-money initialize error', detail);
      if (error && error.response) {
        lastError = {
          ok: false,
          reason: 'gateway_rejected',
          status,
          message: body && (body.message || (body.data && body.data.message))
        };
      } else {
        lastError = { ok: false, reason: 'gateway_error', status };
      }
    }
  }
  return lastError || { ok: false, reason: 'gateway_error' };
}

/**
 * Initialise a hosted checkout.
 *
 * @param {object} params
 * @param {number} params.amountMinor  expected amount in integer minor units
 * @param {string} params.txRef        OUR unique reference for this deposit
 * @param {string} params.callbackUrl  browser redirect after a successful payment
 * @param {string} params.returnUrl    browser redirect when the player cancels/fails
 * @param {string} [params.email]
 * @param {string} [params.firstName]
 * @param {string} [params.lastName]
 * @param {object} [params.meta]
 * @param {object} [opts]              { http } for tests
 * @returns {Promise<{ok:boolean, checkoutUrl?:string, txRef?:string, reason?:string, status?:number}>}
 */
async function initialize(params, opts = {}) {
  const http = opts.http || axios;
  const {
    amountMinor,
    txRef,
    callbackUrl,
    returnUrl,
    email,
    firstName,
    lastName,
    meta
  } = params || {};

  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (!txRef || typeof txRef !== 'string' || txRef.length > 128) {
    return { ok: false, reason: 'invalid_reference' };
  }
  if (!callbackUrl || !returnUrl) return { ok: false, reason: 'missing_redirect_url' };

  const payload = {
    amount: String(fromMinor(amountMinor)),
    currency: 'MWK',
    tx_ref: txRef,
    callback_url: callbackUrl,
    return_url: returnUrl,
    customization: {
      title: 'Aviator Wallet deposit',
      description: `Deposit ${fromMinor(amountMinor)} MWK`
    }
  };
  if (email) payload.email = email;
  if (firstName) payload.first_name = firstName;
  if (lastName) payload.last_name = lastName;
  // PayChangu expects `meta` as an array when provided; include as a single-item
  // array to avoid init rejection while preserving context. Omit if empty.
  if (Array.isArray(meta) && meta.length) {
    payload.meta = meta;
  } else if (meta && typeof meta === 'object') {
    const entries = Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (entries.length) payload.meta = [Object.fromEntries(entries.map(([k, v]) => [k, String(v)]))];
  } else if (typeof meta === 'string' && meta) {
    payload.meta = [meta];
  }

  try {
    const res = await http.post(`${BASE_URL}/payment`, payload, {
      headers: {
        Authorization: `Bearer ${secretKey()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: timeoutMs()
    });

    const body = res && res.data;
    const checkoutUrl =
      (body && body.data && body.data.checkout_url) ||
      (body && body.checkout_url) ||
      null;
    const ok = Boolean(body && (body.status === 'success' || body.status === true) && checkoutUrl);

    if (!ok) {
      console.error('[paychangu] initialize rejected', {
        status: res && res.status,
        bodyStatus: body && body.status,
        message: body && (body.message || (body.data && body.data.message))
      });
      return {
        ok: false,
        reason: 'gateway_rejected',
        status: res && res.status,
        message: body && (body.message || (body.data && body.data.message))
      };
    }
    return { ok: true, txRef, checkoutUrl, status: res.status };
  } catch (error) {
    const status = error && error.response && error.response.status;
    const body = error && error.response && error.response.data;
    const detail = {
      status,
      code: error && error.code,
      message: error && error.message
    };
    if (body) {
      detail.gatewayMessage =
        body.message || (body.data && body.data.message) || body.status;
    }
    console.error('[paychangu] initialize error', detail);
    // HTTP response received = gateway reached but returned an error; treat as rejected, not unreachable.
    if (error && error.response) {
      return {
        ok: false,
        reason: 'gateway_rejected',
        status,
        message: body && (body.message || (body.data && body.data.message))
      };
    }
    // No response (network/DNS/timeout) = truly unreachable.
    return { ok: false, reason: 'gateway_error', status };
  }
}

/**
 * Query the authoritative status of a transaction.
 *
 * @param {string} txRef
 * @param {object} [opts] { http }
 * @returns {Promise<{ok:boolean, paid?:boolean, status?:string,
 *   amountMinor?:number|null, currency?:string, reference?:string|null,
 *   reason?:string, httpStatus?:number}>}
 */
async function verify(txRef, opts = {}) {
  const http = opts.http || axios;
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  if (!txRef || typeof txRef !== 'string') return { ok: false, reason: 'invalid_reference' };

  try {
    const res = await http.get(`${BASE_URL}/verify-payment/${encodeURIComponent(txRef)}`, {
      headers: { Authorization: `Bearer ${secretKey()}`, Accept: 'application/json' },
      timeout: timeoutMs()
    });

    const body = res && res.data;
    const data = (body && body.data) || null;
    if (!data) return { ok: false, reason: 'malformed_response', httpStatus: res && res.status };

    const status = String(data.status || '').toLowerCase();
    const amountMinor = toMinor(data.amount);
    const currency = data.currency ? String(data.currency).toUpperCase() : null;

    return {
      ok: true,
      paid: status === 'success',
      status,
      amountMinor,
      currency,
      reference: data.reference ? String(data.reference) : null,
      httpStatus: res && res.status
    };
  } catch (error) {
    const status = error && error.response && error.response.status;
    const body = error && error.response && error.response.data;
    const message = String(
      (body && (body.message || (body.data && body.data.message))) || ''
    ).toLowerCase();
    // 404 - or a 400 "Payment link not found" for Direct MoMo charges - means
    // PayChangu has no checkout record for this reference yet. Treat as
    // pending, never as a successful payment.
    if (status === 404 || (status === 400 && message.includes('not found'))) {
      return { ok: true, paid: false, status: 'not_found', amountMinor: null, httpStatus: status };
    }
    return { ok: false, reason: 'gateway_error', httpStatus: status };
  }
}

/**
 * Query a Direct Mobile Money charge by its charge id.
 *
 * PayChangu's /verify-payment endpoint explicitly excludes Direct MoMo charges
 * (it answers 400 "Payment link not found"), so those must be checked with the
 * charge-verification endpoint instead.
 *
 * @param {string} chargeId
 * @param {object} [opts] { http }
 * @returns {Promise<{ok:boolean, paid?:boolean, status?:string,
 *   amountMinor?:number|null, currency?:string, reference?:string|null,
 *   reason?:string, httpStatus?:number}>}
 */
async function verifyMobileMoney(chargeId, opts = {}) {
  const http = opts.http || axios;
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  if (!chargeId || typeof chargeId !== 'string') return { ok: false, reason: 'invalid_reference' };

  try {
    const res = await http.get(
      `${BASE_URL}/mobile-money/payments/${encodeURIComponent(chargeId)}/verify`,
      {
        headers: { Authorization: `Bearer ${secretKey()}`, Accept: 'application/json' },
        timeout: timeoutMs()
      }
    );

    const body = res && res.data;
    const data = (body && body.data) || null;
    if (!data) return { ok: false, reason: 'malformed_response', httpStatus: res && res.status };

    const dataStatus = String(data.status || '').toLowerCase();
    const topStatus = String((body && body.status) || '').toLowerCase();
    const status = dataStatus || topStatus;
    // `data.status` is the payment state ('success'/'pending'/'failed'); the
    // top-level status only says the API call worked, so prefer the former.
    const paid = dataStatus
      ? dataStatus === 'success' || dataStatus === 'successful'
      : topStatus === 'successful';
    const rawCurrency = data.currency ? String(data.currency).toUpperCase() : null;
    // Direct charges report the local currency as "MK"; the rest of the app
    // (and the settlement guard) uses the ISO code "MWK".
    const currency = rawCurrency === 'MK' ? 'MWK' : rawCurrency;

    return {
      ok: true,
      paid,
      status,
      amountMinor: toMinor(data.amount),
      currency,
      reference: data.trans_id
        ? String(data.trans_id)
        : data.ref_id
          ? String(data.ref_id)
          : null,
      httpStatus: res && res.status
    };
  } catch (error) {
    const status = error && error.response && error.response.status;
    const body = error && error.response && error.response.data;
    const message = String(
      (body && (body.message || (body.data && body.data.message))) || ''
    ).toLowerCase();
    if (status === 404 || (status === 400 && message.includes('not found'))) {
      return { ok: true, paid: false, status: 'not_found', amountMinor: null, httpStatus: status };
    }
    return { ok: false, reason: 'gateway_error', httpStatus: status };
  }
}

/**
 * Decide whether a verified transaction may be credited.
 *
 * Kept pure so the money rules can be tested without a database. The caller
 * performs the atomic claim/credit only when `ok` is true.
 *
 * @param {object} input
 * @param {number} input.expectedMinor amount WE recorded, in minor units
 * @param {object} input.verification  result of verify()
 * @returns {{ok:boolean, terminal?:boolean, pending?:boolean, reason?:string,
 *   amountMinor?:number, gatewayAmountMinor?:number, overpaid?:boolean}}
 */
function validateSettlement({ expectedMinor, verification } = {}) {
  if (!verification || verification.ok !== true) {
    return { ok: false, pending: true, reason: 'unverifiable' };
  }

  if (!verification.paid) {
    const terminal = ['failed', 'cancelled', 'canceled', 'expired'];
    if (terminal.includes(String(verification.status || '').toLowerCase())) {
      return { ok: false, terminal: true, reason: 'gateway_declined' };
    }
    return { ok: false, pending: true, reason: 'not_paid' };
  }

  if (!Number.isInteger(expectedMinor) || expectedMinor <= 0) {
    return { ok: false, reason: 'bad_expected_amount' };
  }
  if (!verification.currency) {
    return { ok: false, pending: true, reason: 'unreadable_currency' };
  }
  if (verification.currency !== 'MWK') {
    return { ok: false, terminal: true, reason: 'currency_mismatch' };
  }
  if (!Number.isInteger(verification.amountMinor)) {
    return { ok: false, pending: true, reason: 'unreadable_amount' };
  }
  if (verification.amountMinor < expectedMinor) {
    return { ok: false, terminal: true, reason: 'underpaid' };
  }

  return {
    ok: true,
    // Credit what the player asked for, never an overpayment.
    amountMinor: expectedMinor,
    gatewayAmountMinor: verification.amountMinor,
    overpaid: verification.amountMinor > expectedMinor
  };
}

module.exports = {
  BASE_URL,
  isConfigured,
  initialize,
  initializeMobileMoney,
  verify,
  verifyMobileMoney,
  validateSettlement
};
