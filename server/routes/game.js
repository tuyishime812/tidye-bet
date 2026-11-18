const express = require('express');
const router = express.Router();
const { getSupabase, isSupabaseAvailable } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const memoryStore = require('../config/memoryStore');
const { deriveCrashPoint } = require('../game/gameLogic');

// Get bet limits
router.get('/bet-limits', (req, res) => {
  res.json({
    status: true,
    max: 1000,
    min: 1
  });
});

// Get game history
router.get('/history', async (req, res) => {
  if (!isSupabaseAvailable()) {
    return res.json({ status: true, data: [] });
  }
  const supabase = getSupabase();
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const { data: rounds, error } = await supabase
      .from('game_rounds')
      .select('crash_point, round_number, created_at')
      .order('round_number', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('History error:', error);
      return res.json({ status: false, message: 'Failed to get history' });
    }

    const history = rounds.map(r => r.crash_point);
    
    res.json({
      status: true,
      data: history
    });
  } catch (error) {
    console.error('History error:', error);
    res.json({ status: false, message: 'Failed to get history' });
  }
});

/**
 * Get my bets (the signed-in player's bet history).
 *
 * SECURITY: this previously read a username from the request body and returned
 * that player's bets, so any caller could read anyone else's betting history
 * (CWE-639 IDOR). The owner is now taken from the verified JWT and the `name`
 * field is ignored entirely.
 */
router.post('/my-info', requireAuth, async (req, res) => {
  const userId = req.user.userId;

  // Local mode keeps crash bets in memory only for the duration of a round,
  // so there is no durable history to read.
  if (!isSupabaseAvailable()) {
    return res.json({ status: true, data: [] });
  }

  // Sessions from local/in-memory mode (e.g. local_*) are not valid UUIDs in Supabase.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(userId || ''));
  if (!isUuid) {
    return res.json({ status: true, data: [] });
  }

  try {
    const supabase = getSupabase();

    const { data: bets, error } = await supabase
      .from('bets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('My info error:', error);
      return res.status(500).json({ status: false, message: 'Failed to get bet history' });
    }

    const formattedBets = bets.map(bet => ({
      _id: bet.id,
      name: bet.user_name,
      betAmount: bet.bet_amount,
      cashoutAt: bet.cash_out_at,
      cashouted: bet.cashouted,
      date: new Date(bet.created_at).getTime(),
      createdAt: new Date(bet.created_at).getTime(),
      flyAway: bet.fly_away,
      flyDetailID: bet.fly_detail_id
    }));

    res.json({
      status: true,
      data: formattedBets
    });
  } catch (error) {
    console.error('My info error:', error);
    res.status(500).json({ status: false, message: 'Failed to get bet history' });
  }
});

/**
 * Get round details (provably fair).
 *
 * `flyDetailID` reaches us as the bet's fly_detail_id, which is written as
 * `${roundNumber}_${socketId}` on bets but as `${roundNumber}` on the
 * game_rounds row. The old exact-match lookup therefore never found anything
 * for real bets, so the fairness modal was permanently blank. Parse the round
 * number out of the identifier and look it up by round_number instead, while
 * still accepting a plain round number / legacy fly_detail_id.
 */
router.post('/round-details', async (req, res) => {
  if (!isSupabaseAvailable()) {
    return res.json({ status: false, message: 'Round not found' });
  }
  const supabase = getSupabase();
  try {
    const raw = req.body && req.body.flyDetailID;
    const flyDetailID =
      typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';

    if (!flyDetailID) {
      return res.json({ status: false, message: 'Round not found' });
    }

    const roundMatch = /^(\d+)/.exec(flyDetailID);
    let query = supabase.from('game_rounds').select('*');
    if (roundMatch) {
      query = query.eq('round_number', Number(roundMatch[1]));
    } else {
      query = query.eq('fly_detail_id', flyDetailID);
    }

    const { data, error } = await query.limit(1);
    const round = Array.isArray(data) ? data[0] : null;

    if (!round || error) {
      return res.json({ status: false, message: 'Round not found' });
    }

    // Prove the result instead of asking the player to trust it: recompute the
    // crash point from the published seeds. An operator-forced round cannot be
    // reproduced and must say so rather than presenting the override as fair.
    const clientSeeds = Array.isArray(round.client_seeds) ? round.client_seeds : [];
    const forced = round.forced === true;
    const derived = deriveCrashPoint(round.server_seed, clientSeeds);
    const matches = Math.abs(derived - Number(round.crash_point)) < 1e-9;

    res.json({
      status: true,
      data: {
        serverSeed: round.server_seed,
        serverSeedHash: round.server_seed_hash,
        clientSeeds,
        crashPoint: round.crash_point,
        createdAt: new Date(round.created_at).getTime(),
        // `verifiable` is false when the published seeds cannot reproduce the
        // result (operator override). `verified` is the independent check for
        // normal rounds.
        verifiable: !forced,
        verified: forced ? null : matches,
        forced,
        forcedBy: forced ? round.forced_by || null : null,
        reason: forced ? 'operator_override' : null
      }
    });
  } catch (error) {
    console.error('Round details error:', error);
    res.json({ status: false, message: 'Failed to get round details' });
  }
});

// Get top bets (highest profits)
router.get('/top-bets', async (req, res) => {
  if (!isSupabaseAvailable()) {
    return res.json({ status: true, data: [] });
  }
  const supabase = getSupabase();
  try {
    const limit = parseInt(req.query.limit) || 20;
    
    const { data: bets, error } = await supabase
      .from('bets')
      .select(`
        *,
        users (
          user_name,
          avatar
        )
      `)
      .eq('cashouted', true)
      // Losers are also written with cashouted=true and cash_out_at=0. Without
      // this filter they pad the leaderboard with 0.00x "top bets".
      .gt('profit', 0)
      .order('profit', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Top bets error:', error);
      return res.json({ status: false, message: 'Failed to get top bets' });
    }

    res.json({
      status: true,
      data: bets
    });
  } catch (error) {
    console.error('Top bets error:', error);
    res.json({ status: false, message: 'Failed to get top bets' });
  }
});

module.exports = router;
