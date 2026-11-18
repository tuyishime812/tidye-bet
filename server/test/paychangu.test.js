'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const paychangu = require('../services/paychangu');

const KEY = 'sec-test-key';

function withEnv(vars, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a placeholder secret in .env.example is not treated as configured', async () => {
  await withEnv({ PAYCHANGU_SECRET_KEY: 'sec-your-secret-key-here' }, async () => {
    assert.equal(paychangu.isConfigured(), false);
    const result = await paychangu.verify('pch_' + '0'.repeat(32));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_configured');
  });
});

test('initialize refuses to run without a secret key', async () => {
  await withEnv({ PAYCHANGU_SECRET_KEY: undefined }, async () => {
    const result = await paychangu.initialize({
      amountMinor: 500000,
      txRef: 'pch_' + 'a'.repeat(32),
      callbackUrl: 'https://example.test/return',
      returnUrl: 'https://example.test/return'
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_configured');
  });
});

test('initialize sends the documented payload and returns the checkout URL', async () => {
  const calls = [];
  const http = {
    post: async (url, payload, config) => {
      calls.push({ url, payload, config });
      return {
        status: 200,
        data: { status: 'success', data: { checkout_url: 'https://checkout.paychangu.com/abc' } }
      };
    }
  };

  await withEnv({ PAYCHANGU_SECRET_KEY: KEY }, async () => {
    const result = await paychangu.initialize(
      {
        amountMinor: 500000, // 5,000.00 MWK
        txRef: 'pch_' + 'b'.repeat(32),
        callbackUrl: 'https://app.test/payment/return',
        returnUrl: 'https://app.test/payment/return',
        firstName: 'Test',
        meta: { depositId: 'dep-1' }
      },
      { http }
    );

    assert.equal(result.ok, true);
    assert.equal(result.checkoutUrl, 'https://checkout.paychangu.com/abc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.paychangu.com/payment');
    assert.equal(calls[0].payload.amount, '5000');
    assert.equal(calls[0].payload.currency, 'MWK');
    assert.equal(calls[0].payload.tx_ref, 'pch_' + 'b'.repeat(32));
    assert.equal(calls[0].payload.callback_url, 'https://app.test/payment/return');
    assert.equal(calls[0].payload.meta[0].depositId, 'dep-1');
    assert.equal(calls[0].config.headers.Authorization, `Bearer ${KEY}`);
  });
});

test('initialize does not expose a checkout URL when the gateway rejects it', async () => {
  const http = {
    post: async () => ({ status: 400, data: { status: 'failed', message: 'bad request' } })
  };

  await withEnv({ PAYCHANGU_SECRET_KEY: KEY }, async () => {
    const result = await paychangu.initialize(
      {
        amountMinor: 500000,
        txRef: 'pch_' + 'c'.repeat(32),
        callbackUrl: 'https://app.test/return',
        returnUrl: 'https://app.test/return'
      },
      { http }
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'gateway_rejected');
  });
});

test('verify treats a successful payment as paid with amount in minor units', async () => {
  const http = {
    get: async (url, config) => {
      assert.equal(url, 'https://api.paychangu.com/verify-payment/pch_' + 'd'.repeat(32));
      assert.equal(config.headers.Authorization, `Bearer ${KEY}`);
      return {
        status: 200,
        data: {
          status: 'success',
          data: {
            status: 'success',
            amount: 5000,
            currency: 'MWK',
            reference: 'TX-123'
          }
        }
      };
    }
  };

  await withEnv({ PAYCHANGU_SECRET_KEY: KEY }, async () => {
    const result = await paychangu.verify('pch_' + 'd'.repeat(32), { http });
    assert.equal(result.ok, true);
    assert.equal(result.paid, true);
    assert.equal(result.amountMinor, 500000);
    assert.equal(result.currency, 'MWK');
    assert.equal(result.reference, 'TX-123');
  });
});

test('verify treats a 404 as pending, never as paid', async () => {
  const http = {
    get: async () => {
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }
  };

  await withEnv({ PAYCHANGU_SECRET_KEY: KEY }, async () => {
    const result = await paychangu.verify('pch_' + 'e'.repeat(32), { http });
    assert.equal(result.ok, true);
    assert.equal(result.paid, false);
    assert.equal(result.status, 'not_found');
  });
});

test('verify treats a 400 "Payment link not found" as not_found (Direct MoMo)', async () => {
  const http = {
    get: async () => {
      const error = new Error('bad request');
      error.response = {
        status: 400,
        data: { status: 'failed', message: 'Payment link not found.' }
      };
      throw error;
    }
  };

  await withEnv({ PAYCHANGU_SECRET_KEY: KEY }, async () => {
    const result = await paychangu.verify('pch_' + 'f'.repeat(32), { http });
    assert.equal(result.ok, true);
    assert.equal(result.paid, false);
    assert.equal(result.status, 'not_found');
  });
});

test('verifyMobileMoney reads a Direct MoMo charge and normalizes MK to MWK', async () => {
  const ref = 'pch_' + 'a1'.repeat(16);
  const http = {
    get: async (url, config) => {
      assert.equal(url, `https://api.paychangu.com/mobile-money/payments/${ref}/verify`);
      assert.equal(config.headers.Authorization, `Bearer ${KEY}`);
      return {
        status: 200,
        data: {
          status: 'success',
          message: 'Transaction has already been validated as successful.',
          data: {
            charge_id: ref,
            trans_id: 'trans-123',
            status: 'success',
            amount: '100.00',
            currency: 'MK'
          }
        }
      };
    }
  };

  await withEnv({ PAYCHANGU_SECRET_KEY: KEY }, async () => {
    const result = await paychangu.verifyMobileMoney(ref, { http });
    assert.equal(result.ok, true);
    assert.equal(result.paid, true);
    assert.equal(result.status, 'success');
    assert.equal(result.amountMinor, 10000);
    assert.equal(result.currency, 'MWK');
    assert.equal(result.reference, 'trans-123');
  });
});

test('verifyMobileMoney treats a 404 charge as pending', async () => {
  const http = {
    get: async () => {
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }
  };

  await withEnv({ PAYCHANGU_SECRET_KEY: KEY }, async () => {
    const result = await paychangu.verifyMobileMoney('pch_' + 'b2'.repeat(16), { http });
    assert.equal(result.ok, true);
    assert.equal(result.paid, false);
    assert.equal(result.status, 'not_found');
  });
});

test('settlement accepts an exact MWK payment and credits the expected amount', () => {
  const result = paychangu.validateSettlement({
    expectedMinor: 500000,
    verification: {
      ok: true,
      paid: true,
      status: 'success',
      currency: 'MWK',
      amountMinor: 500000
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.amountMinor, 500000);
  assert.equal(result.overpaid, false);
});

test('settlement credits only the requested amount when the player overpays', () => {
  const result = paychangu.validateSettlement({
    expectedMinor: 500000,
    verification: {
      ok: true,
      paid: true,
      status: 'success',
      currency: 'MWK',
      amountMinor: 900000
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.amountMinor, 500000);
  assert.equal(result.gatewayAmountMinor, 900000);
  assert.equal(result.overpaid, true);
});

test('settlement refuses an underpayment instead of crediting it', () => {
  const result = paychangu.validateSettlement({
    expectedMinor: 500000,
    verification: {
      ok: true,
      paid: true,
      status: 'success',
      currency: 'MWK',
      amountMinor: 499999
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.reason, 'underpaid');
});

test('settlement refuses a foreign currency (the 1000x unit trap)', () => {
  const result = paychangu.validateSettlement({
    expectedMinor: 500000,
    verification: {
      ok: true,
      paid: true,
      status: 'success',
      currency: 'USD',
      amountMinor: 500000
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.reason, 'currency_mismatch');
});

test('settlement treats a missing currency or amount as pending, never paid', () => {
  const noCurrency = paychangu.validateSettlement({
    expectedMinor: 500000,
    verification: {
      ok: true,
      paid: true,
      status: 'success',
      currency: null,
      amountMinor: 500000
    }
  });
  assert.equal(noCurrency.ok, false);
  assert.equal(noCurrency.pending, true);
  assert.equal(noCurrency.reason, 'unreadable_currency');

  const noAmount = paychangu.validateSettlement({
    expectedMinor: 500000,
    verification: {
      ok: true,
      paid: true,
      status: 'success',
      currency: 'MWK',
      amountMinor: null
    }
  });
  assert.equal(noAmount.ok, false);
  assert.equal(noAmount.pending, true);
  assert.equal(noAmount.reason, 'unreadable_amount');
});

test('settlement marks a gateway decline as terminal but keeps pending as pending', () => {
  const declined = paychangu.validateSettlement({
    expectedMinor: 500000,
    verification: { ok: true, paid: false, status: 'failed' }
  });
  assert.equal(declined.ok, false);
  assert.equal(declined.terminal, true);
  assert.equal(declined.reason, 'gateway_declined');

  const pending = paychangu.validateSettlement({
    expectedMinor: 500000,
    verification: { ok: true, paid: false, status: 'not_found' }
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.pending, true);
  assert.equal(pending.reason, 'not_paid');
});

test('settlement refuses an unverifiable response', () => {
  const result = paychangu.validateSettlement({
    expectedMinor: 500000,
    verification: { ok: false, reason: 'gateway_error' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.equal(result.reason, 'unverifiable');
});
