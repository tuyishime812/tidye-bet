const crypto = require('crypto');
const { getSupabase, isSupabaseAvailable } = require('../config/supabase');
const ledger = require('../services/ledger');
const money = require('../config/money');
const { manualCrashDefault, manualCrashFallbackMs } = require('../config/gameControls');

/**
 * Bet panel keys the client may submit.
 *
 * This is an allow-list, not a style choice: `type` is echoed back to the
 * client and used as a property key when building per-player state. Accepting
 * arbitrary strings there would let a caller write to `__proto__`/`constructor`
 * on those payload objects (prototype tampering) as well as desynchronise the
 * UI from the bets the server actually holds.
 */
const BET_PANELS = ['f', 's', 't', 'q'];
const isBetPanel = (type) => typeof type === 'string' && BET_PANELS.includes(type);

/** Hard ceiling on a single round's multiplier (fair global cap). */
const CRASH_CEILING = 6;

/**
 * Width of the integer sampled from the seed hash.
 *
 * The fairness modal (src/components/Main/seedModal.tsx) shows the first 13
 * hex characters of SHA512(serverSeed + clientSeeds) as both the "Hex" and
 * "Decimal" fields, so the crash point must be derived from exactly those
 * 52 bits or the number the player is shown cannot be checked by hand.
 */
const CRASH_SPACE = 2 ** 52;

/**
 * Derive a round's crash point from the seeds.
 *
 * WHY THIS IS A PURE FUNCTION
 * ---------------------------
 * The UI advertises "provably fair" and displays Server Seed, Client Seeds,
 * the combined SHA512 hash and the resulting multiplier. The crash point used
 * to be drawn from crypto.randomBytes() instead, so the published seeds had no
 * causal relationship to the result and the verification screen was theatre
 * rather than proof. Deriving the multiplier from the committed seeds makes the
 * claim true: anyone can recompute SHA512(serverSeed + clientSeeds), take the
 * first 13 hex chars and reproduce the exact crash point.
 *
 * The server seed is hashed (SHA256 commitment) and published before the round
 * begins, then revealed after the crash, so the server cannot change it after
 * seeing the players' seeds (CWE-345 / insufficient verification of data
 * authenticity).
 *
 * @param {string} serverSeed  the round's secret server seed
 * @param {string[]} clientSeeds  seeds contributed by players this round
 * @returns {number} crash point in [1, 1000], rounded to 2dp
 */
function deriveCrashPoint(serverSeed, clientSeeds = []) {
  const seeds = Array.isArray(clientSeeds) ? clientSeeds : [];
  // Must match seedModal.tsx exactly: no separator, server seed first.
  const combined = `${serverSeed}${seeds.join('')}`;
  const hash = crypto.createHash('sha512').update(combined).digest('hex');
  const h = parseInt(hash.slice(0, 13), 16);

  // 3% instant crashes, matching the previous distribution.
  if (!Number.isFinite(h) || h % 33 === 0) return 1.0;

  const crash = Math.floor((100 * CRASH_SPACE - h) / (CRASH_SPACE - h)) / 100;
  return Math.max(1, Math.min(crash, CRASH_CEILING));
}

class Game {
  constructor(io) {
    this.io = io;
    this.currentNum = 0;
    this.GameState = 'BET';
    this.time = 0;
    this.history = [];
    this.bettedUsers = [];
    this.previousHand = [];
    
    this.minBet = 1;
    this.maxBet = 1000;
    
    this.serverSeed = this.generateServerSeed();
    this.serverSeedHash = this.hashServerSeed(this.serverSeed);
    this.clientSeeds = [];
    // Snapshot of the seeds actually used for the current round. Players may
    // keep changing their seed during the flight; without a snapshot the stored
    // client_seeds would no longer be the ones the crash point was derived from
    // and the fairness check would fail.
    this.roundServerSeed = this.serverSeed;
    this.roundClientSeeds = [];
    this.currentRound = 0;
    this.crashPoint = 0;

    // Manual control (admin) settings
    this.adminMode = manualCrashDefault(); // true = every round waits for the operator
    this.forcedCrashPoint = null;    // next round uses this value when set
    this.forcedCrashBy = null;       // who set it (audit trail)
    this.waitingForAdmin = false;    // true = round is paused waiting for admin input
    this.adminFallbackMs = manualCrashFallbackMs(); // 0 = wait indefinitely
    this.adminFallbackTimer = null;
    this.adminFallbackAt = null;     // epoch ms when the automatic fallback fires

    // Fairness audit for the CURRENT round. `forced` rounds are not derivable
    // from the published seeds and must be disclosed as such.
    this.roundForced = false;
    this.roundForcedBy = null;
    this.roundVerified = null;
    
    this.userBalances = new Map();
    // In-flight auto-cashout credits. crash() waits for these before it decides
    // which bets are losses.
    this.pendingSettlements = new Set();
    
    this.gameInterval = null;
    this.betTime = 5000;
    this.flyTime = 0;
  }

  async initRoundCounter() {
    try {
      const { getSupabase, isSupabaseAvailable } = require('../config/supabase');
      if (!isSupabaseAvailable()) return;
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('game_rounds')
        .select('round_number')
        .order('round_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.warn('[game] could not read latest round number:', error.message);
        return;
      }
      const maxRound = data && Number.isFinite(Number(data.round_number)) ? Number(data.round_number) : 0;
      if (maxRound > this.currentRound) {
        this.currentRound = maxRound;
        console.log(`[game] resuming round counter from ${this.currentRound}`);
      }
    } catch (error) {
      console.warn('[game] round counter init failed:', error.message);
    }
  }

  generateServerSeed() {
    return crypto.randomBytes(16).toString('hex');
  }

  hashServerSeed(seed) {
    return crypto.createHash('sha256').update(seed).digest('hex');
  }

  generateCrashPoint(serverSeed = this.serverSeed, clientSeeds = this.clientSeeds) {
    return deriveCrashPoint(serverSeed, clientSeeds);
  }

  // ============================================
  // ADMIN / MANUAL CONTROL METHODS
  // ============================================

  /** Cancel a pending "admin is busy" fallback, if any. */
  clearAdminFallbackTimer() {
    if (this.adminFallbackTimer) {
      clearTimeout(this.adminFallbackTimer);
      this.adminFallbackTimer = null;
    }
    this.adminFallbackAt = null;
  }

  /**
   * Start the auto fallback timer for a paused manual-mode round.
   *
   * The timer only fires if the round is still paused and the operator has not
   * set a crash point in the meantime. That condition is re-checked inside the
   * callback, so an admin action racing the timer cannot start a second flight.
   */
  scheduleAdminFallback() {
    this.clearAdminFallbackTimer();
    if (!this.adminMode || !this.waitingForAdmin || this.adminFallbackMs <= 0) return;

    this.adminFallbackAt = Date.now() + this.adminFallbackMs;
    this.adminFallbackTimer = setTimeout(() => {
      this.adminFallbackTimer = null;
      this.adminFallbackAt = null;

      if (
        !this.adminMode ||
        !this.waitingForAdmin ||
        this.GameState !== 'BET' ||
        this.forcedCrashPoint !== null
      ) {
        return;
      }

      this.waitingForAdmin = false;
      console.log('🎛️ Admin busy - falling back to an automatic crash point');
      this.emitAdminState(this.getAdminState());
      this.startFlyingPhase();
    }, this.adminFallbackMs);

    // Never keep a test runner or a shutting-down process alive for the timer.
    if (typeof this.adminFallbackTimer.unref === 'function') this.adminFallbackTimer.unref();
  }

  setAdminMode(enabled, actor = null) {
    this.adminMode = Boolean(enabled);
    if (!this.adminMode) {
      this.clearAdminFallbackTimer();
      this.forcedCrashPoint = null;
      this.forcedCrashBy = null;
      // If the round was paused waiting for admin input, resume it automatically
      if (this.waitingForAdmin && this.GameState === 'BET') {
        this.waitingForAdmin = false;
        setTimeout(() => this.startFlyingPhase(), 1000);
      } else {
        this.waitingForAdmin = false;
      }
    }
    const state = this.getAdminState();
    this.emitAdminState(state);
    console.log(`🎛️ Admin mode ${this.adminMode ? 'ENABLED (manual crash point control)' : 'DISABLED (auto random)'}`);
    return state;
  }

  setNextCrashPoint(value, actor = null) {
    const crash = parseFloat(value);
    if (isNaN(crash) || crash < 1 || crash > CRASH_CEILING) {
      return { success: false, error: `Crash point must be between 1 and ${CRASH_CEILING}` };
    }
    this.forcedCrashPoint = crash;
    this.forcedCrashBy = actor ? String(actor).slice(0, 60) : 'unknown-admin';

    // If the round is paused waiting for input, start flying right away. The
    // fallback timer is cancelled so it cannot race this explicit decision.
    if (this.waitingForAdmin && this.GameState === 'BET') {
      this.waitingForAdmin = false;
      this.clearAdminFallbackTimer();
      setTimeout(() => this.startFlyingPhase(), 1000);
    }

    const state = this.getAdminState();
    this.emitAdminState(state);
    console.log(`🎛️ Next crash point set to ${crash.toFixed(2)}x` + (this.adminMode ? ' (manual mode)' : ' (single override)'));

    return { success: true, crashPoint: crash };
  }

  clearNextCrashPoint() {
    this.forcedCrashPoint = null;
    this.forcedCrashBy = null;
    const state = this.getAdminState();
    this.emitAdminState(state);
    return { success: true, forcedCrashPoint: null };
  }

  emitAdminState(state) {
    if (this.io) {
      this.io.to('admin-room').emit('adminState', state);
    }
  }

  getAdminState() {
    return {
      adminMode: this.adminMode,
      forcedCrashPoint: this.forcedCrashPoint,
      waitingForAdmin: this.waitingForAdmin,
      fallbackMs: this.adminFallbackMs,
      fallbackAt: this.adminFallbackAt,
      gameState: this.GameState,
      currentRound: this.currentRound,
      currentNum: this.currentNum,
      currentCrashPoint: this.crashPoint,
      // Fairness disclosure for the admin console: a forced round is visible as
      // such instead of looking like a normal random result.
      roundForced: this.roundForced,
      roundForcedBy: this.roundForcedBy,
      roundVerified: this.roundVerified,
      history: this.history.slice(0, 15),
      bettedUsersCount: this.bettedUsers.length
    };
  }

  startGameLoop() {
    this.gameLoop();
  }

  gameLoop() {
    this.clearAdminFallbackTimer();
    this.GameState = 'BET';
    this.currentNum = 0;
    this.time = this.betTime;
    this.bettedUsers = [];
    this.clientSeeds = [];
    this.roundForced = false;
    this.roundForcedBy = null;
    this.roundVerified = null;
    
    this.io.to('game-room').emit('gameState', {
      currentNum: 0,
      currentSecondNum: 0,
      GameState: 'BET',
      time: this.betTime
    });

    // MANUAL MODE: if admin control is enabled and no crash point has been
    // set for the next round, wait for the admin to provide one before flying.
    // A timeout keeps the game alive when the operator is busy, so players are
    // never stuck at the betting screen indefinitely.
    if (this.adminMode && this.forcedCrashPoint === null) {
      this.waitingForAdmin = true;
      this.emitAdminState(this.getAdminState());
      this.scheduleAdminFallback();
      console.log(
        '🎛️ Manual mode - waiting for admin to set the crash point' +
          (this.adminFallbackMs > 0 ? ` (auto fallback in ${Math.round(this.adminFallbackMs / 1000)}s)...` : '...')
      );
      return;
    }
    this.waitingForAdmin = false;
    this.clearAdminFallbackTimer();

    setTimeout(() => {
      this.startFlyingPhase();
    }, this.betTime);
  }

  async startFlyingPhase() {
    // Idempotency: an admin set-point, a mode toggle and the fallback timer can
    // all race to start the same round. Only the first caller may transition it.
    if (this.GameState !== 'BET') return;
    this.clearAdminFallbackTimer();
    this.GameState = 'FLYING';
    this.currentNum = 1.00;
    this.currentRound++;
    this.waitingForAdmin = false;

    // Freeze the seeds for this round. The crash point is a deterministic
    // function of them, so the snapshot is what the fairness endpoint must
    // publish afterwards (not the live, still-mutable this.clientSeeds).
    this.roundServerSeed = this.serverSeed;
    this.roundClientSeeds = this.clientSeeds.slice();

    // Use the admin-forced crash point if set, otherwise derive it from the
    // committed server seed and the players' client seeds. A forced round is
    // recorded as such so the fairness endpoint can disclose it instead of
    // presenting an unverifiable result as proof.
    this.roundForced = false;
    this.roundForcedBy = null;
    this.roundVerified = null;

    if (this.forcedCrashPoint !== null) {
      this.crashPoint = this.forcedCrashPoint;
      this.roundForced = true;
      this.roundForcedBy = this.forcedCrashBy || 'unknown-admin';
      this.forcedCrashPoint = null;
      this.forcedCrashBy = null;
    } else {
      this.crashPoint = this.generateCrashPoint(this.roundServerSeed, this.roundClientSeeds);
    }

    this.emitAdminState(this.getAdminState());

    console.log(`Round ${this.currentRound} - Crash point: ${this.crashPoint.toFixed(2)}x`);

    const startTime = Date.now();
    this.flyTime = 0;

    // Send immediate state update
    this.io.to('game-room').emit('gameState', {
      currentNum: 1.00,
      currentSecondNum: 1.00,
      GameState: 'FLYING',
      time: 0
    });

    const flyInterval = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      this.flyTime = elapsed;

      // Smoother exponential growth formula matching frontend
      this.currentNum = 1.00 + 0.1 * (elapsed / 1000) + Math.pow((0.08 * elapsed / 1000), 2) - Math.pow((0.03 * elapsed / 1000), 3) + Math.pow((0.02 * elapsed / 1000), 4);

      // Emit real-time updates at 60fps
      this.io.to('game-room').emit('gameState', {
        currentNum: parseFloat(this.currentNum.toFixed(2)),
        currentSecondNum: parseFloat(this.currentNum.toFixed(2)),
        GameState: 'FLYING',
        time: elapsed
      });

      // Crash first, then settle auto-cashouts that were reached *before* this
      // tick. Settling after the crash check is what stops a target above the
      // crash point from being paid on a coarse tick.
      if (this.currentNum >= this.crashPoint) {
        clearInterval(flyInterval);
        await this.crash();
        return;
      }

      // Server-side auto-cashout. The client used to drive this from the
      // browser, which meant a backgrounded/throttled tab missed its own target.
      // The authoritative tick now settles every reached target exactly once.
      this.settleReachedAutoCashouts();
    }, 16); // 60fps updates
  }

  async crash() {
    // Idempotency: the flying interval clears before awaiting, but a future
    // caller must not be able to settle the same round twice.
    if (this.GameState === 'CRASHED' || this.GameState === 'CRASHING') return;

    // Close the manual cash-out window BEFORE any await. Without this, a
    // cashOut event that arrives while the auto-settlements below are in flight
    // would see GameState === 'FLYING' and be paid at a multiplier above the
    // crash point.
    this.GameState = 'CRASHING';

    // Fairness fix: a 16ms tick can jump from below a player's auto-cashout
    // target to beyond the crash point. Any target at or below the published
    // crash point was, by definition, reached before the crash, so settle it at
    // its requested price before marking the remaining bets as losses.
    await this.settleAutoCashoutsUpTo(this.crashPoint);

    this.GameState = 'CRASHED';

    const remainingBets = this.bettedUsers.filter(bet => !bet.cashouted);
    for (const bet of remainingBets) {
      bet.cashouted = true;
      bet.cashOutAt = 0;
      bet.profit = 0;
      
      // Save lost bet
      if (bet.userId && isSupabaseAvailable()) {
        const supabase = getSupabase();
        await supabase.from('bets').insert([{
          user_id: bet.userId,
          user_name: bet.userName,
          bet_amount: bet.betAmount,
          cash_out_at: 0,
          cashouted: true,
          fly_away: this.crashPoint,
          fly_detail_id: `${this.currentRound}_${bet.socketId}`,
          profit: 0,
          game_round: this.currentRound
        }]);
      }
    }

    // Save game round
    if (isSupabaseAvailable()) {
      const supabase = getSupabase();
      // Publish the snapshot the crash point was actually derived from, not
      // whatever the live seed list looks like now.
      const roundServerSeed = this.roundServerSeed || this.serverSeed;
      const roundClientSeeds = Array.isArray(this.roundClientSeeds)
        ? this.roundClientSeeds
        : this.clientSeeds;

      // Integrity self-check: recompute the crash point from the published
      // seeds. For a forced round this is intentionally NOT expected to match,
      // which is exactly what `forced` discloses.
      const derived = this.generateCrashPoint(roundServerSeed, roundClientSeeds);
      const verified = this.roundForced ? null : Math.abs(derived - this.crashPoint) < 1e-9;
      this.roundVerified = verified;

      if (verified === false) {
        console.error(
          `[fairness] CRITICAL: round ${this.currentRound} crash_point ` +
            `${this.crashPoint} does not match deriveCrashPoint()=${derived}. ` +
            'The published seeds do not prove this result.'
        );
      }

      const baseRound = {
        round_number: this.currentRound,
        crash_point: this.crashPoint,
        server_seed: roundServerSeed,
        server_seed_hash: this.hashServerSeed(roundServerSeed),
        client_seeds: roundClientSeeds,
        fly_detail_id: `${this.currentRound}`
      };

      const enrichedRound = {
        ...baseRound,
        forced: this.roundForced,
        forced_by: this.roundForcedBy,
        verified
      };

      // Include the audit columns when the schema has them, but never lose the
      // round record (and therefore the players' proof) because a live
      // database has not run the migration yet.
      const insertRound = async (payload) => supabase.from('game_rounds').insert([payload]);
      const isDuplicateRound = (err) =>
        err && (err.code === '23505' || /duplicate key|game_rounds_round_number_key/i.test(err.message || ''));

      let { error } = await insertRound(enrichedRound);
      if (error && isDuplicateRound(error)) {
        // Counter can be stale after restart/race; jump to next available round number.
        try {
          const { data: maxRow } = await supabase
            .from('game_rounds')
            .select('round_number')
            .order('round_number', { ascending: false })
            .limit(1)
            .maybeSingle();
          const maxRound = maxRow && Number.isFinite(Number(maxRow.round_number)) ? Number(maxRow.round_number) : this.currentRound;
          const nextRound = Math.max(this.currentRound, maxRound) + 1;
          if (nextRound !== this.currentRound) {
            console.warn(`[game] round ${this.currentRound} duplicate, retrying as round ${nextRound}`);
            this.currentRound = nextRound;
          }
        } catch (_) {
          this.currentRound += 1;
        }
        const fixedBase = { ...baseRound, round_number: this.currentRound, fly_detail_id: `${this.currentRound}` };
        const fixedEnriched = { ...enrichedRound, round_number: this.currentRound, fly_detail_id: `${this.currentRound}` };
        ({ error } = await insertRound(fixedEnriched));
        if (error) {
          console.error('[game] round insert with audit columns failed:', error.message);
          const retry = await insertRound(fixedBase);
          if (retry.error) {
            console.error('[game] round insert failed:', retry.error.message);
          }
        }
      } else if (error) {
        console.error('[game] round insert with audit columns failed:', error.message);
        const retry = await insertRound(baseRound);
        if (retry.error) {
          console.error('[game] round insert failed:', retry.error.message);
        }
      }
    }

    this.history.unshift(parseFloat(this.crashPoint.toFixed(2)));
    if (this.history.length > 50) {
      this.history = this.history.slice(0, 50);
    }

    this.io.to('game-room').emit('gameState', {
      currentNum: parseFloat(this.crashPoint.toFixed(2)),
      currentSecondNum: parseFloat(this.crashPoint.toFixed(2)),
      GameState: 'CRASHED',
      time: this.time
    });

    this.emitAdminState(this.getAdminState());

    this.io.to('game-room').emit('history', this.history);
    this.previousHand = [...this.bettedUsers];
    this.io.to('game-room').emit('previousHand', this.publicBets());

    // Emit a detailed per-player finish payload so the client can run its
    // auto-bet / stop-win / stop-loss logic correctly.
    const players = new Map();
    for (const bet of this.bettedUsers) {
      if (!isBetPanel(bet.type)) continue;
      if (!players.has(bet.socketId)) {
        players.set(bet.socketId, {
          f: { betted: false, cashouted: false, cashAmount: 0, betAmount: 0, auto: false },
          s: { betted: false, cashouted: false, cashAmount: 0, betAmount: 0, auto: false },
          t: { betted: false, cashouted: false, cashAmount: 0, betAmount: 0, auto: false },
          q: { betted: false, cashouted: false, cashAmount: 0, betAmount: 0, auto: false }
        });
      }
      const entry = players.get(bet.socketId);
      entry[bet.type] = {
        betted: true,
        cashouted: bet.cashOut > 0,
        cashAmount: bet.profit > 0 ? bet.profit : 0,
        betAmount: bet.betAmount,
        auto: !!bet.auto
      };
    }
    for (const [socketId, payload] of players) {
      this.io.to(socketId).emit('finishGame', payload);
    }

    this.serverSeed = this.generateServerSeed();
    this.serverSeedHash = this.hashServerSeed(this.serverSeed);

    setTimeout(() => {
      this.gameLoop();
    }, 3000);
  }

  async placeBet(socket, data) {
    if (!data || typeof data !== 'object') {
      socket.emit('error', { message: 'Invalid bet request' });
      return;
    }

    const { betAmount, target, type, auto, autoCashout, seed } = data;

    if (!isBetPanel(type)) {
      socket.emit('error', { message: 'Invalid bet type', index: type });
      return;
    }

    // Auto-cashout is settled by the server now, so the multiplier must be a
    // real, reachable number. A missing/NaN target used to be stored silently
    // and could never fire.
    const autoCashoutOn = autoCashout === true;
    const targetNum = Number(target);
    if (autoCashoutOn && (!Number.isFinite(targetNum) || targetNum <= 1 || targetNum > CRASH_CEILING)) {
      socket.emit('error', {
        message: `Auto-cashout must be between 1.01x and ${CRASH_CEILING}x`,
        index: type
      });
      return;
    }

    // SECURITY: bets are only valid while the round is accepting them. Without
    // this guard a player could bet mid-flight and immediately cash out at the
    // current multiplier (guaranteed profit), or bet during CRASHED and have the
    // stake wiped when the next gameLoop clears bettedUsers without a refund.
    if (this.GameState !== 'BET') {
      socket.emit('error', {
        message: 'Betting is closed for this round',
        index: type
      });
      return;
    }

    // Strict numeric validation. The old loose comparison let non-numeric
    // input through when no userId was present and stored NaN in betAmount.
    const amount = Number(betAmount);
    if (!Number.isFinite(amount) || amount < this.minBet || amount > this.maxBet) {
      socket.emit('error', {
        message: `Bet amount must be between ${this.minBet} and ${this.maxBet}`,
        index: type
      });
      return;
    }

    // Allow unlimited bets per user per round (like 1winbet style)

    // Record the client seed for provably fair verification
    if (typeof seed === 'string' && seed.trim()) {
      this.addClientSeed(seed.trim());
    }

    // Convert once, before any money moves. toMinor() rejects ambiguous input
    // (NaN, Infinity, junk strings) instead of coercing it to a number.
    const stakeMinor = money.toMinor(amount);
    if (stakeMinor === null || stakeMinor <= 0) {
      socket.emit('error', {
        message: 'Invalid bet amount',
        index: type
      });
      return;
    }

    // INSTANT bet placement - deduct balance immediately.
    // Money moves through the ledger (single choke point, per-user FIFO in
    // memory mode / row-lock in Postgres mode).
    if (socket.userId) {
      try {
        const res = await ledger.debit({
          userId: socket.userId,
          amountMinor: stakeMinor,
          reason: 'BET_STAKE',
          refType: 'bet',
          metadata: { game: 'aviator', round: this.currentRound, index: type }
        });

        if (!res.ok) {
          // Correct the client's optimistic deduction immediately. Without
          // this, a rejected bet (stale client balance / concurrent bet) left
          // the UI showing less money than the player actually had until the
          // next refresh.
          try {
            const bal = await ledger.getBalance(socket.userId);
            if (bal.ok) {
              socket.emit('myInfo', { balance: money.fromMinor(bal.balance) });
            }
          } catch (_) {
            // The error below still tells the client why the bet failed.
          }
          socket.emit('error', {
            message: res.reason === 'Insufficient balance' ? 'Insufficient balance' : 'Failed to place bet',
            index: type
          });
          return;
        }
      } catch (error) {
        console.error('Error deducting balance:', error);
        socket.emit('error', {
          message: 'Failed to place bet',
          index: type
        });
        return;
      }
    }

    const bet = {
      socketId: socket.id,
      userId: socket.userId,
      userName: socket.userName || 'Player',
      betAmount: amount,
      stakeMinor, // used for exact cashout math
      cashOut: 0,
      cashouted: false,
      target: Number.isFinite(targetNum) && targetNum > 0 ? targetNum : 2,
      auto: auto || false,
      autoCashout: autoCashoutOn,
      disconnected: false,
      type: type,
      img: socket.avatar || '',
      profit: 0
    };

    this.bettedUsers.push(bet);

    console.log(`🎲 Bet placed: ${bet.userName} - ${amount} MWK (Type: ${type})`);

    // INSTANT update - emit to ALL clients immediately
    this.io.to('game-room').emit('bettedUserInfo', this.publicBets());
    
    // Send confirmation to the player who bet. Report every panel that this
    // socket currently holds, so a multi-panel client cannot mistake an
    // accepted t/q bet for an empty panel and re-arm it.
    const panelState = {
      f: { betted: false, betAmount: 0 },
      s: { betted: false, betAmount: 0 },
      t: { betted: false, betAmount: 0 },
      q: { betted: false, betAmount: 0 }
    };
    for (const activeBet of this.bettedUsers) {
      if (activeBet.socketId === socket.id && isBetPanel(activeBet.type)) {
        panelState[activeBet.type] = {
          betted: true,
          betAmount: activeBet.betAmount
        };
      }
    }
    socket.emit('myBetState', panelState);
    
    socket.emit('success', 'Bet placed!');

    // Send updated balance (read through the ledger, which knows the truth in
    // both storage modes).
    if (socket.userId) {
      const res = await ledger.getBalance(socket.userId);
      if (res.ok) {
        socket.emit('myInfo', { balance: money.fromMinor(res.balance) });
      }
    }
  }

  async cashOut(socket, data) {
    if (!data || typeof data !== 'object') {
      socket.emit('error', { message: 'Invalid cash out request' });
      return;
    }

    const { type } = data;

    if (!isBetPanel(type)) {
      socket.emit('error', { message: 'Invalid bet type', index: type });
      return;
    }

    const bet = this.bettedUsers.find(b => b.socketId === socket.id && b.type === type);
    if (!bet || bet.cashouted) {
      socket.emit('error', {
        message: 'No active bet to cash out',
        index: type
      });
      return;
    }

    if (this.GameState !== 'FLYING') {
      socket.emit('error', {
        message: 'Cannot cash out now',
        index: type
      });
      return;
    }

    // INSTANT cashout at current multiplier
    const cashOutAt = this.currentNum;
    if (!Number.isFinite(cashOutAt) || cashOutAt < 1) {
      socket.emit('error', {
        message: 'Cannot cash out now',
        index: type
      });
      return;
    }

    const result = await this.settleBet(bet, cashOutAt, { source: 'manual' });
    if (!result.ok) {
      socket.emit('error', {
        message: 'Could not cash out, please try again',
        index: type
      });
      return;
    }

    if (result.balance !== undefined) {
      socket.emit('myInfo', { balance: money.fromMinor(result.balance) });
    }
    this.emitPanelState(socket.id);
    socket.emit('success', `Cashed out at ${cashOutAt.toFixed(2)}x! Won ${bet.profit.toFixed(2)} MWK`);
  }

  /**
   * Settle one bet at `cashOutAt` through the ledger.
   *
   * Shared by the manual cash-out and the server-side auto-cashout so both have
   * identical money semantics: synchronous settlement flag (blocks a second
   * payout), exact minor-unit maths, ledger row in the same operation, and a
   * rollback if the credit is rejected.
   *
   * The caller is responsible for emit/toast; this only touches state + money.
   *
   * @returns {Promise<{ok:boolean, balance?:number, reason?:string}>}
   */
  async settleBet(bet, cashOutAt, opts = {}) {
    if (!bet || bet.cashouted) return { ok: false, reason: 'already_settled' };
    if (!Number.isFinite(cashOutAt) || cashOutAt < 1) {
      return { ok: false, reason: 'invalid_multiplier' };
    }

    // Mark settled synchronously so a concurrent manual cash-out cannot observe
    // the bet as still active while the ledger call is in flight.
    bet.cashouted = true;
    bet.cashOut = cashOutAt;
    bet.profit = bet.betAmount * cashOutAt;

    const rollback = () => {
      bet.cashouted = false;
      bet.cashOut = 0;
      bet.profit = 0;
    };

    if (!bet.userId) {
      // No account (should be impossible on the authenticated socket path):
      // record the bet but never pretend money moved.
      this.io.to('game-room').emit('bettedUserInfo', this.publicBets());
      return { ok: true };
    }

    let payoutMinor;
    try {
      // At exactly 1.00x the player simply gets their stake back.
      payoutMinor = cashOutAt <= 1
        ? (bet.stakeMinor || 0)
        : money.multiplyByOdds(bet.stakeMinor || 0, cashOutAt);
    } catch (error) {
      console.error('Error computing payout:', error);
      rollback();
      this.io.to('game-room').emit('bettedUserInfo', this.publicBets());
      return { ok: false, reason: 'payout_math' };
    }

    if (!payoutMinor || payoutMinor <= 0) {
      rollback();
      this.io.to('game-room').emit('bettedUserInfo', this.publicBets());
      return { ok: false, reason: 'payout_amount' };
    }

    let creditRes;
    try {
      creditRes = await ledger.credit({
        userId: bet.userId,
        amountMinor: payoutMinor,
        reason: 'BET_PAYOUT',
        refType: 'bet',
        metadata: {
          game: 'aviator',
          round: this.currentRound,
          cashOutAt,
          index: bet.type,
          settlement: opts.source || 'manual'
        }
      });
    } catch (error) {
      console.error('Error crediting payout:', error);
      rollback();
      this.io.to('game-room').emit('bettedUserInfo', this.publicBets());
      return { ok: false, reason: 'payout_failed' };
    }

    if (!creditRes || !creditRes.ok) {
      // Never report a win the player was not paid for.
      console.error('Payout rejected:', creditRes && creditRes.reason);
      rollback();
      this.io.to('game-room').emit('bettedUserInfo', this.publicBets());
      return { ok: false, reason: (creditRes && creditRes.reason) || 'payout_rejected' };
    }

    // Game history row (database modes only - memory mode keeps no bet history
    // for Aviator). A history write failure must NOT undo a payout that already
    // succeeded, so this is logged rather than rolled back.
    if (isSupabaseAvailable()) {
      try {
        await getSupabase().from('bets').insert([{
          user_id: bet.userId,
          user_name: bet.userName,
          bet_amount: bet.betAmount,
          cash_out_at: bet.cashOut,
          cashouted: true,
          fly_away: this.crashPoint,
          fly_detail_id: `${this.currentRound}_${bet.socketId || bet.userId}`,
          profit: bet.profit,
          game_round: this.currentRound
        }]);
      } catch (error) {
        console.error('Error saving cashout history:', error);
      }
    }

    this.io.to('game-room').emit('bettedUserInfo', this.publicBets());
    return { ok: true, balance: creditRes.balance };
  }

  /** Settle auto-cashouts whose target the current tick has reached. */
  settleReachedAutoCashouts() {
    if (this.GameState !== 'FLYING') return;
    for (const bet of [...this.bettedUsers]) {
      if (bet.cashouted || !bet.autoCashout) continue;
      if (!Number.isFinite(bet.target) || bet.target <= 1) continue;
      if (this.currentNum >= bet.target) this.settleAuto(bet, bet.target);
    }
  }

  /**
   * Settle every auto-cashout target at or below `limit`.
   *
   * Called from crash() with the crash point so a coarse tick can never turn a
   * winning auto-cashout into a loss.
   */
  async settleAutoCashoutsUpTo(limit) {
    const pending = [];
    for (const bet of [...this.bettedUsers]) {
      if (bet.cashouted || !bet.autoCashout) continue;
      if (!Number.isFinite(bet.target) || bet.target <= 1) continue;
      if (bet.target <= limit) {
        const p = this.settleAuto(bet, bet.target);
        if (p) pending.push(p);
      }
    }
    await Promise.allSettled(pending);
  }

  /**
   * Fire-and-forget auto settlement. The bet is flagged synchronously, so the
   * flying tick or the crash handler cannot settle it a second time.
   */
  settleAuto(bet, at) {
    if (!bet || bet.cashouted) return null;
    const promise = this.settleBet(bet, at, { source: 'auto' })
      .then((result) => {
        if (result.ok && result.balance !== undefined) {
          const socket = this.liveSocket(bet.socketId);
          if (socket) {
            socket.emit('myInfo', { balance: money.fromMinor(result.balance) });
            socket.emit('success', `Auto cashed out at ${at.toFixed(2)}x!`);
            this.emitPanelState(socket.id);
          }
        }
        return result;
      })
      .catch((error) => {
        console.error('Auto cashout failed:', error);
        return { ok: false, reason: 'auto_failed' };
      });

    this.pendingSettlements.add(promise);
    promise.finally(() => this.pendingSettlements.delete(promise));
    return promise;
  }

  /** Resolve a socket id against the live namespace (null when disconnected). */
  liveSocket(socketId) {
    if (!socketId || !this.io || !this.io.sockets || !this.io.sockets.sockets) return null;
    return this.io.sockets.sockets.get(socketId) || null;
  }

  /** Push the authoritative per-panel bet flags to one socket. */
  emitPanelState(socketId) {
    const socket = this.liveSocket(socketId);
    if (!socket) return;
    const panelState = {
      f: { betted: false, betAmount: 0 },
      s: { betted: false, betAmount: 0 },
      t: { betted: false, betAmount: 0 },
      q: { betted: false, betAmount: 0 }
    };
    for (const bet of this.bettedUsers) {
      if (bet.socketId === socketId && !bet.cashouted && isBetPanel(bet.type)) {
        panelState[bet.type] = { betted: true, betAmount: bet.betAmount };
      }
    }
    socket.emit('myBetState', panelState);
  }

  /**
   * Public projection of the live bet list.
   *
   * The raw bet objects carry `userId`, `socketId` and `stakeMinor`, none of
   * which a spectator needs. Broadcasting them leaked stable account
   * identifiers and per-bet stake precision to every player in the room
   * (CWE-200). `name` is included because the client UI renders it.
   */
  publicBets() {
    return this.bettedUsers.map((bet) => ({
      name: bet.userName,
      userName: bet.userName,
      betAmount: bet.betAmount,
      cashOut: bet.cashOut,
      cashouted: bet.cashouted,
      target: bet.target,
      auto: bet.auto,
      autoCashout: bet.autoCashout,
      type: bet.type,
      img: bet.img
    }));
  }

  /**
   * Re-attach a reconnected player to bets placed under their previous socket.
   *
   * Without this, a dropped connection (mobile network, tab sleep) made the
   * player's own stake unsettleable: the bet stayed in the round but no socket
   * could cash it out.
   */
  rebindSocket(socket) {
    if (!socket || !socket.userId) return;
    let changed = false;
    for (const bet of this.bettedUsers) {
      if (
        !bet.cashouted &&
        bet.userId === socket.userId &&
        bet.socketId !== socket.id &&
        bet.disconnected
      ) {
        bet.socketId = socket.id;
        bet.disconnected = false;
        changed = true;
      }
    }
    if (changed) {
      this.io.to('game-room').emit('bettedUserInfo', this.publicBets());
    }
    this.emitPanelState(socket.id);
  }

  handleDisconnect(socket) {
    const mine = this.bettedUsers.filter((bet) => bet.socketId === socket.id);
    if (!mine.length) return;

    if (this.GameState === 'BET') {
      // The round never started: the stake was already debited, so refund it.
      // Otherwise a player who drops during the 5s betting window silently
      // loses money and the round has no record of it (repudiation).
      for (const bet of mine) {
        if (bet.cashouted) continue;
        bet.cashouted = true;
        if (bet.userId) {
          ledger.credit({
            userId: bet.userId,
            amountMinor: bet.stakeMinor || money.toMinor(bet.betAmount) || 0,
            reason: 'BET_REFUND',
            refType: 'bet',
            metadata: {
              game: 'aviator',
              round: this.currentRound,
              reason: 'disconnect_before_flight'
            }
          }).then((res) => {
            if (!res || !res.ok) {
              console.error('[game] disconnect refund failed:', res && res.reason);
            }
          }).catch((error) => {
            console.error('[game] disconnect refund threw:', error.message);
          });
        }
      }
      this.bettedUsers = this.bettedUsers.filter((bet) => bet.socketId !== socket.id);
    } else {
      // The round is live: keep the bet so crash() records the loss. Mark it
      // orphaned; rebindSocket() re-attaches it if the player returns.
      for (const bet of mine) {
        if (!bet.cashouted) bet.disconnected = true;
      }
    }

    this.io.to('game-room').emit('bettedUserInfo', this.publicBets());
  }

  getGameState() {
    return {
      currentNum: this.currentNum,
      currentSecondNum: this.currentNum,
      GameState: this.GameState,
      time: this.time
    };
  }

  addClientSeed(seed) {
    if (typeof seed !== 'string') return;
    const trimmed = seed.trim();
    if (!trimmed || trimmed.length > 128) return;
    // A client registers its seed on connect (changeClientSeed) and also sends
    // it with every bet, so identical values arrive repeatedly within a round.
    // Deduplicating keeps the published seed set small and meaningful and stops
    // one connection from filling the cap with copies of its own seed.
    if (this.clientSeeds.includes(trimmed)) return;
    // Bound the list so a client cannot grow it without limit by repeatedly
    // emitting changeClientSeed, and keep the round's seed set small enough to
    // publish and verify.
    if (this.clientSeeds.length >= 256) return;
    this.clientSeeds.push(trimmed);
  }

  getProvablyFairData() {
    return {
      serverSeedHash: this.serverSeedHash,
      clientSeeds: this.clientSeeds,
      round: this.currentRound
    };
  }
}

let gameInstance = null;

async function initializeGame(io) {
  gameInstance = new Game(io);
  await gameInstance.initRoundCounter();
  gameInstance.startGameLoop();
  return gameInstance;
}

function getGameInstance() {
  return gameInstance;
}

module.exports = {
  Game,
  initializeGame,
  getGameInstance,
  deriveCrashPoint,
  CRASH_CEILING
};
