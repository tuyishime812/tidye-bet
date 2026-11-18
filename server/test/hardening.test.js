/**
 * Regression tests for the launch-blocker hardening pass.
 *
 * These cover the money-integrity controls that are easy to regress silently:
 *   - manual crash control is OFF by default in production
 *   - the ledger refuses a balance movement whose sign contradicts its reason
 *   - a suspended account is rejected at the money boundary, not just at login
 *   - the live-bet broadcast does not leak account identifiers
 *   - auto-cashout is settled server-side, exactly once, at the requested price
 *   - disconnecting during BET refunds the stake; during FLYING the loss stands
 *   - a reconnect re-binds the player to their still-live bet
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../services/ledger');
const memoryStore = require('../config/memoryStore');
const playerStatus = require('../services/playerStatus');
const {
  manualCrashAllowed,
  manualCrashReason,
  manualCrashDefault,
  manualCrashFallbackMs
} = require('../config/gameControls');
const { requireActivePlayer } = require('../middleware/auth');
const { Game } = require('../game/gameLogic');

let counter = 0;

/**
 * Create a disposable memory-mode account with a starting balance in MWK.
 *
 * The opening balance is issued through the ledger (not written directly), so
 * the fixture obeys the same invariant the reconciliation script checks. The
 * credit is queued on the per-user FIFO before any debit the test performs.
 */
function makeUser(balance = 100, extra = {}) {
  counter += 1;
  const user = memoryStore.createUser({
    phone_number: '',
    user_name: `hardening_${Date.now().toString(36)}_${counter}`,
    password: 'test-hash',
    email: '',
    balance: 0,
    ...extra
  });
  if (balance > 0) {
    ledger
      .credit({
        userId: user.id,
        amountMinor: Math.round(balance * 100),
        reason: 'ADMIN_CREDIT',
        metadata: { source: 'test opening balance' }
      })
      .catch(() => {});
  }
  return user;
}

/** Minimal socket.io stub: records room emits, no live sockets. */
function ioStub() {
  const events = [];
  return {
    events,
    to: () => ({ emit: (name, payload) => events.push({ name, payload }) }),
    sockets: { sockets: new Map() }
  };
}

function wait(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Invoke an Express middleware against tiny fake req/res objects. */
function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        resolve({ res, next: false });
      }
    };
    Promise.resolve(mw(req, res, () => resolve({ res, next: true }))).catch(() =>
      resolve({ res, next: false, threw: true })
    );
  });
}

// ---------------------------------------------------------------------------
// Manual crash control
// ---------------------------------------------------------------------------

test('manual crash control is disabled by default in production', () => {
  assert.equal(manualCrashAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(manualCrashAllowed({ NODE_ENV: 'production', ALLOW_MANUAL_CRASH: 'true' }), true);
  assert.equal(manualCrashAllowed({ NODE_ENV: 'production', ALLOW_MANUAL_CRASH: '1' }), true);
  assert.equal(manualCrashAllowed({ NODE_ENV: 'production', ALLOW_MANUAL_CRASH: 'yes' }), true);
  assert.equal(manualCrashAllowed({ NODE_ENV: 'production', ALLOW_MANUAL_CRASH: 'false' }), false);
  assert.equal(manualCrashAllowed({ NODE_ENV: 'production', ALLOW_MANUAL_CRASH: '0' }), false);
});

test('manual crash control defaults on outside production but can be disabled', () => {
  assert.equal(manualCrashAllowed({ NODE_ENV: 'development' }), true);
  assert.equal(manualCrashAllowed({ NODE_ENV: 'test' }), true);
  assert.equal(manualCrashAllowed({ NODE_ENV: 'development', ALLOW_MANUAL_CRASH: 'false' }), false);
  assert.match(manualCrashReason({ NODE_ENV: 'production' }), /DISABLED/);
});

test('manual mode is opt-in and the fallback timeout is clamped', () => {
  assert.equal(manualCrashDefault({}), false);
  assert.equal(manualCrashDefault({ ADMIN_MANUAL_DEFAULT: 'true' }), true);
  assert.equal(manualCrashDefault({ ADMIN_MANUAL_DEFAULT: '1' }), true);
  assert.equal(manualCrashDefault({ ADMIN_MANUAL_DEFAULT: 'yes' }), true);
  assert.equal(manualCrashDefault({ ADMIN_MANUAL_DEFAULT: 'false' }), false);

  assert.equal(manualCrashFallbackMs({}), 20_000);
  assert.equal(manualCrashFallbackMs({ MANUAL_CRASH_FALLBACK_MS: '0' }), 0);
  assert.equal(manualCrashFallbackMs({ MANUAL_CRASH_FALLBACK_MS: '7500' }), 7500);
  assert.equal(manualCrashFallbackMs({ MANUAL_CRASH_FALLBACK_MS: '9999999' }), 300_000);
  assert.equal(manualCrashFallbackMs({ MANUAL_CRASH_FALLBACK_MS: 'nonsense' }), 20_000);
});

test('the admin-busy fallback resumes a paused manual round', async () => {
  const io = ioStub();
  const game = Object.create(Game.prototype);
  game.io = io;
  game.GameState = 'BET';
  game.adminMode = true;
  game.waitingForAdmin = true;
  game.forcedCrashPoint = null;
  game.adminFallbackMs = 20;
  game.adminFallbackAt = null;
  game.adminFallbackTimer = null;
  game.history = [];
  game.currentRound = 0;
  game.bettedUsers = [];

  let started = 0;
  game.startFlyingPhase = () => {
    started += 1;
    game.GameState = 'FLYING';
  };

  game.scheduleAdminFallback();
  assert.equal(typeof game.adminFallbackAt, 'number');
  await wait(60);
  assert.equal(game.waitingForAdmin, false);
  assert.equal(started, 1);

  // A timeout that loses the race to a forced point must not start a round.
  game.GameState = 'BET';
  game.adminMode = true;
  game.waitingForAdmin = true;
  game.forcedCrashPoint = null;
  game.scheduleAdminFallback();
  game.forcedCrashPoint = 3;
  await wait(60);
  assert.equal(started, 1);
  game.clearAdminFallbackTimer();
});

// ---------------------------------------------------------------------------
// Ledger sign-per-reason (SCHEMA_AUDIT M-C)
// ---------------------------------------------------------------------------

test('ledger refuses a sign that contradicts the reason', async () => {
  const user = makeUser(100); // 10,000 minor

  const wrongSignUp = await ledger.moveBalance({
    userId: user.id,
    amountMinor: -100,
    reason: 'DEPOSIT'
  });
  assert.equal(wrongSignUp.ok, false);
  assert.match(wrongSignUp.reason, /must increase/);

  const wrongSignDown = await ledger.moveBalance({
    userId: user.id,
    amountMinor: 100,
    reason: 'BET_STAKE'
  });
  assert.equal(wrongSignDown.ok, false);
  assert.match(wrongSignDown.reason, /must decrease/);

  const payoutDown = await ledger.moveBalance({
    userId: user.id,
    amountMinor: -100,
    reason: 'BET_PAYOUT'
  });
  assert.equal(payoutDown.ok, false);

  // credit() forces the amount positive, so a debit reason must still bounce.
  const creditAsStake = await ledger.credit({
    userId: user.id,
    amountMinor: 100,
    reason: 'BET_STAKE'
  });
  assert.equal(creditAsStake.ok, false);

  // The legitimate directions still work.
  const credit = await ledger.credit({
    userId: user.id,
    amountMinor: 500,
    reason: 'ADMIN_CREDIT'
  });
  assert.equal(credit.ok, true);

  const debit = await ledger.debit({
    userId: user.id,
    amountMinor: 500,
    reason: 'BET_STAKE'
  });
  assert.equal(debit.ok, true);
});

// ---------------------------------------------------------------------------
// Ban enforcement at the money boundary
// ---------------------------------------------------------------------------

test('playerStatus reflects a ban immediately after invalidate()', async () => {
  const user = makeUser(10);
  playerStatus.clearCache();
  assert.equal(await playerStatus.isBanned(user.id), false);
  memoryStore.setBanned(user.id, true, 'unit test');
  playerStatus.invalidate(user.id);
  assert.equal(await playerStatus.isBanned(user.id), true);
});

test('requireActivePlayer blocks a suspended account and passes an active one', async () => {
  const active = makeUser(10);
  const banned = makeUser(10);
  memoryStore.setBanned(banned.id, true, 'unit test');
  playerStatus.clearCache();

  const ok = await runMiddleware(requireActivePlayer, { user: { userId: active.id } });
  assert.equal(ok.next, true);

  const blocked = await runMiddleware(requireActivePlayer, { user: { userId: banned.id } });
  assert.equal(blocked.next, false);
  assert.equal(blocked.res.statusCode, 403);
  assert.match(blocked.res.body.message, /suspended/i);
});

// ---------------------------------------------------------------------------
// Broadcast redaction
// ---------------------------------------------------------------------------

test('publicBets() does not leak userId, socketId or stakeMinor', () => {
  const game = Object.create(Game.prototype);
  game.bettedUsers = [
    {
      socketId: 'socket-secret',
      userId: 'user-secret',
      userName: 'alice',
      betAmount: 10,
      stakeMinor: 1000,
      cashOut: 2,
      cashouted: true,
      target: 2,
      auto: false,
      autoCashout: true,
      type: 'f',
      img: ''
    }
  ];

  const [pub] = game.publicBets();
  assert.equal(pub.userId, undefined);
  assert.equal(pub.socketId, undefined);
  assert.equal(pub.stakeMinor, undefined);
  assert.equal(pub.name, 'alice');
  assert.equal(pub.userName, 'alice');
  assert.equal(pub.betAmount, 10);
  assert.equal(pub.cashOut, 2);
});

// ---------------------------------------------------------------------------
// Server-side auto-cashout
// ---------------------------------------------------------------------------

function makeGame(io) {
  const game = Object.create(Game.prototype);
  game.io = io;
  game.bettedUsers = [];
  game.pendingSettlements = new Set();
  game.currentRound = 1;
  game.crashPoint = 5;
  game.currentNum = 1.5;
  game.GameState = 'FLYING';
  return game;
}

function betFor(user, overrides = {}) {
  return {
    socketId: `socket-${user.id}`,
    userId: user.id,
    userName: user.user_name,
    betAmount: 10,
    stakeMinor: 1000,
    cashOut: 0,
    cashouted: false,
    target: 1.5,
    auto: false,
    autoCashout: true,
    disconnected: false,
    type: 'f',
    img: '',
    ...overrides
  };
}

test('auto-cashout settles at the target exactly once', async () => {
  const user = makeUser(100); // 10,000 minor
  const debit = await ledger.debit({ userId: user.id, amountMinor: 1000, reason: 'BET_STAKE' });
  assert.equal(debit.ok, true);

  const game = makeGame(ioStub());
  game.bettedUsers.push(betFor(user));

  game.settleReachedAutoCashouts();
  assert.equal(game.bettedUsers[0].cashouted, true);
  assert.equal(game.bettedUsers[0].cashOut, 1.5);

  await Promise.allSettled([...game.pendingSettlements]);

  const after = await ledger.getBalance(user.id);
  // 10,000 - 1,000 stake + 1,500 payout
  assert.equal(after.balance, 10500);

  // A second tick must not pay again.
  game.settleReachedAutoCashouts();
  await wait();
  const again = await ledger.getBalance(user.id);
  assert.equal(again.balance, after.balance);
});

test('auto-cashout does not fire below the target', async () => {
  const user = makeUser(100);
  await ledger.debit({ userId: user.id, amountMinor: 1000, reason: 'BET_STAKE' });

  const game = makeGame(ioStub());
  game.currentNum = 1.2;
  game.bettedUsers.push(betFor(user, { target: 1.5 }));

  game.settleReachedAutoCashouts();
  assert.equal(game.bettedUsers[0].cashouted, false);
});

test('crash settles auto-cashout targets at or below the crash point', async () => {
  const user = makeUser(100);
  await ledger.debit({ userId: user.id, amountMinor: 1000, reason: 'BET_STAKE' });

  const io = ioStub();
  const game = makeGame(io);
  game.crashPoint = 2;
  game.currentNum = 2.0;
  game.bettedUsers.push(betFor(user, { target: 1.8 }));

  await game.settleAutoCashoutsUpTo(game.crashPoint);

  assert.equal(game.bettedUsers[0].cashouted, true);
  assert.equal(game.bettedUsers[0].cashOut, 1.8);
  const after = await ledger.getBalance(user.id);
  // 10,000 - 1,000 + 1,800
  assert.equal(after.balance, 10800);
});

// ---------------------------------------------------------------------------
// Disconnect accounting
// ---------------------------------------------------------------------------

test('disconnect during BET refunds the stake and removes the bet', async () => {
  const user = makeUser(100); // 10,000 minor
  await ledger.debit({ userId: user.id, amountMinor: 1000, reason: 'BET_STAKE' });

  const game = makeGame(ioStub());
  game.GameState = 'BET';
  const bet = betFor(user, { autoCashout: false });
  game.bettedUsers.push(bet);

  game.handleDisconnect({ id: bet.socketId });

  assert.equal(game.bettedUsers.length, 0);
  await wait(80);
  const after = await ledger.getBalance(user.id);
  assert.equal(after.balance, 10000, 'stake must be returned');
});

test('disconnect during FLYING keeps the bet so the loss is recorded', () => {
  const user = makeUser(100);
  const game = makeGame(ioStub());
  game.GameState = 'FLYING';
  const bet = betFor(user);
  game.bettedUsers.push(bet);

  game.handleDisconnect({ id: bet.socketId });

  assert.equal(game.bettedUsers.length, 1);
  assert.equal(game.bettedUsers[0].disconnected, true);
  assert.equal(game.bettedUsers[0].cashouted, false);
});

test('a reconnect re-binds the player to their live bet', () => {
  const user = makeUser(100);
  const game = makeGame(ioStub());
  game.GameState = 'FLYING';
  const bet = betFor(user, { socketId: 'old-socket', disconnected: true });
  game.bettedUsers.push(bet);

  const socket = { id: 'new-socket', userId: user.id, emit() {} };
  game.rebindSocket(socket);

  assert.equal(bet.socketId, 'new-socket');
  assert.equal(bet.disconnected, false);
});
