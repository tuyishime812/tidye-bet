/**
 * Operator-control gates for the crash game.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * `setNextCrashPoint()` is a money-minting primitive: an operator (or anyone who
 * steals an admin token) can force a maximum-payout round and cash out an
 * accomplice's bet. It also destroys the provable-fairness claim, because the
 * published server seed no longer derives the published crash point.
 *
 * The control must therefore be OFF by default wherever real money is at stake.
 * Keeping the decision in one tiny, dependency-free function makes it testable
 * and impossible to forget at one of the three call sites (HTTP, socket, boot).
 *
 * Resolution order:
 *   1. ALLOW_MANUAL_CRASH=true|1|yes  -> enabled
 *   2. ALLOW_MANUAL_CRASH=false|0|no -> disabled
 *   3. otherwise                     -> enabled only outside production
 */
function manualCrashAllowed(env = process.env) {
  const raw = String(env.ALLOW_MANUAL_CRASH ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return String(env.NODE_ENV || '').toLowerCase() !== 'production';
}

/**
 * Human-readable reason for the current state, used in the boot banner and the
 * 403 body so an operator can fix the configuration without reading the code.
 */
function manualCrashReason(env = process.env) {
  return manualCrashAllowed(env)
    ? 'manual crash control is ENABLED' +
        (String(env.NODE_ENV || '').toLowerCase() === 'production'
          ? ' by ALLOW_MANUAL_CRASH'
          : ' (non-production default)')
    : 'manual crash control is DISABLED (set ALLOW_MANUAL_CRASH=true to override)';
}

/**
 * Whether a fresh game starts in "manual mode" (every round waits for the
 * operator's crash point). Opt-in, because the default must stay automatic if
 * the env is not deliberately configured for operator control.
 */
function manualCrashDefault(env = process.env) {
  const raw = String(env.ADMIN_MANUAL_DEFAULT ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * How long a manual-mode round waits for the operator before it falls back to a
 * normal, seed-derived crash point. This is the "admin is busy" path: it keeps
 * the game moving instead of freezing every player at the betting screen.
 *
 * 0 disables the fallback (wait indefinitely). Valid range is 0..300000 ms.
 */
const DEFAULT_MANUAL_FALLBACK_MS = 20_000;
const MAX_MANUAL_FALLBACK_MS = 300_000;

function manualCrashFallbackMs(env = process.env) {
  const raw = Number(env.MANUAL_CRASH_FALLBACK_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MANUAL_FALLBACK_MS;
  return Math.min(Math.round(raw), MAX_MANUAL_FALLBACK_MS);
}

module.exports = {
  manualCrashAllowed,
  manualCrashReason,
  manualCrashDefault,
  manualCrashFallbackMs
};
