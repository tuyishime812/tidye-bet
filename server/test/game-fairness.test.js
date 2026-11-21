/**
 * Crash-game fairness and bet-gating regression tests.
 *
 * WHY THESE EXIST
 * ---------------
 * 1. The fairness modal publishes the server seed, the players' seeds and a
 *    combined SHA512 hash, then shows a multiplier. The multiplier used to be
 *    drawn from crypto.randomBytes() instead of the published seeds, so the
 *    "provably fair" proof could never reproduce the result. These tests pin
 *    the derivation to the exact published algorithm.
 * 2. placeBet() used to accept bets in any state. A player could bet mid-flight
 *    and cash out immediately at the current multiplier (guaranteed profit), or
 *    bet during CRASHED and have the stake wiped when the next round began.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { Game, deriveCrashPoint, CRASH_CEILING } = require('../game/gameLogic');

// ---------------------------------------------------------------------------
// Independent reimplementation of the documented algorithm, used to prove that
// the module and the fairness screen agree.
// ---------------------------------------------------------------------------
function referenceCrashPoint(serverSeed, clientSeeds) {
  const combined = `${serverSeed}${clientSeeds.join('')}`;
  const hex = crypto.createHash('sha512').update(combined).digest('hex');
  const h = parseInt(hex.slice(0, 13), 16);
  if (h % 33 === 0) return 1.0;
  const space = 2 ** 52;
  return Math.max(1, Math.min(Math.floor((100 * space - h) / (space - h)) / 100, CRASH_CEILING));
}

test('deriveCrashPoint matches the published SHA512 algorithm', () => {
  assert.equal(deriveCrashPoint('abc', ['x']), referenceCrashPoint('abc', ['x']));
  assert.equal(deriveCrashPoint('abc', []), referenceCrashPoint('abc', []));
  assert.equal(deriveCrashPoint('server-seed', ['alice', 'bob']), referenceCrashPoint('server-seed', ['alice', 'bob']));
});

test('deriveCrashPoint is deterministic and stable (known vectors)', () => {
  // If the algorithm changes, players embedding these values in a verifier will
  // be told their (correct) result is wrong. Pin the vectors (clamped to the
  // global fair cap CRASH_CEILING).
  assert.equal(deriveCrashPoint('abc', ['x']), 5.98);
  assert.equal(deriveCrashPoint('abc', []), 6.35);
  assert.equal(deriveCrashPoint('deadbeef', []), 1.07);
  assert.equal(deriveCrashPoint('abc', ['x']), deriveCrashPoint('abc', ['x']));
});

test('deriveCrashPoint always returns a bounded, 2dp multiplier', () => {
  for (let i = 0; i < 500; i++) {
    const seed = crypto.randomBytes(16).toString('hex');
    const seeds = i % 3 === 0 ? [] : [crypto.randomBytes(4).toString('hex')];
    const crash = deriveCrashPoint(seed, seeds);
    assert.ok(crash >= 1, `crash ${crash} below 1`);
    assert.ok(crash <= CRASH_CEILING, `crash ${crash} above ceiling`);
    assert.equal(crash, Math.round(crash * 100) / 100);
  }
});

test('deriveCrashPoint tolerates a missing/!array client seed list', () => {
  assert.equal(deriveCrashPoint('abc'), deriveCrashPoint('abc', []));
  assert.equal(deriveCrashPoint('abc', null), deriveCrashPoint('abc', []));
});

// ---------------------------------------------------------------------------
// placeBet() state gating
// ---------------------------------------------------------------------------

/**
 * Build a Game without running the constructor, so no timers/game loop start.
 * Only the fields placeBet() touches are populated.
 */
function makeGame(state) {
  const game = Object.create(Game.prototype);
  game.GameState = state;
  game.bettedUsers = [];
  game.clientSeeds = [];
  game.minBet = 1;
  game.maxBet = 1000;
  game.currentRound = 1;
  game.io = { to: () => ({ emit() {} }) };
  return game;
}

function makeSocket() {
  const events = [];
  return {
    id: 'socket-1',
    userId: null,
    userName: 'tester',
    avatar: '',
    emit(event, payload) {
      events.push({ event, payload });
    },
    events
  };
}

function lastError(socket) {
  return socket.events.filter((e) => e.event === 'error').pop();
}

test('placeBet is rejected while the round is FLYING', async () => {
  const game = makeGame('FLYING');
  const socket = makeSocket();

  await game.placeBet(socket, { betAmount: 10, target: 2, type: 'f' });

  assert.equal(game.bettedUsers.length, 0, 'no bet may be accepted mid-flight');
  const err = lastError(socket);
  assert.ok(err, 'client must be told why');
  assert.match(err.payload.message, /closed/i);
});

test('placeBet is rejected while the round is CRASHED', async () => {
  const game = makeGame('CRASHED');
  const socket = makeSocket();

  await game.placeBet(socket, { betAmount: 10, target: 2, type: 'f' });

  assert.equal(game.bettedUsers.length, 0, 'no bet may be accepted between rounds');
  assert.ok(lastError(socket));
});

test('placeBet rejects a non-numeric amount even without a userId', async () => {
  const game = makeGame('BET');
  const socket = makeSocket();

  await game.placeBet(socket, { betAmount: 'not-a-number', target: 2, type: 'f' });

  assert.equal(game.bettedUsers.length, 0);
  assert.match(lastError(socket).payload.message, /between/i);
});

test('placeBet accepts a valid bet during BET and stores exact minor units', async () => {
  const game = makeGame('BET');
  const socket = makeSocket();

  await game.placeBet(socket, { betAmount: 10.5, target: 2, type: 'f', seed: '  my-seed  ' });

  assert.equal(game.bettedUsers.length, 1);
  const bet = game.bettedUsers[0];
  assert.equal(bet.betAmount, 10.5);
  assert.equal(bet.stakeMinor, 1050);
  assert.equal(bet.type, 'f');
  assert.deepEqual(game.clientSeeds, ['my-seed'], 'seed is trimmed and recorded');
});

test('addClientSeed bounds the round seed set', () => {
  const game = makeGame('BET');
  for (let i = 0; i < 1000; i++) game.addClientSeed(`seed-${i}`);
  assert.equal(game.clientSeeds.length, 256);
  game.addClientSeed('one-more');
  assert.equal(game.clientSeeds.length, 256);

  const fresh = makeGame('BET');
  fresh.addClientSeed(42);
  fresh.addClientSeed('   ');
  fresh.addClientSeed('x'.repeat(129));
  assert.deepEqual(fresh.clientSeeds, [], 'non-string, blank and oversized seeds are ignored');
});

test('addClientSeed ignores a duplicate seed within the round', () => {
  const game = makeGame('BET');
  game.addClientSeed('same-seed');
  game.addClientSeed('  same-seed  ');
  game.addClientSeed('same-seed');

  assert.deepEqual(game.clientSeeds, ['same-seed'], 'repeated registration is idempotent');
});
