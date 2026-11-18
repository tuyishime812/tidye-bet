# Hardening pass — 2026-11-04

This documents the launch-blocker fixes applied after the review in
`SECURITY_REPORT.md`, `SCHEMA_AUDIT.md` and `FIXES_SUMMARY.md`. It is the
"what changed / what to do next" companion to those documents.

Everything below is code + schema. Operational items that cannot be completed
from a repository (licensing, live gateway keys, live database verification) are
listed at the end.

---

## 1. Money-integrity fixes

### 1.1 Manual crash override is now a gated, audited control

**Threat:** `setNextCrashPoint()` lets an operator — or anyone who steals an
admin token — force a 1000x round and cash out an accomplice's bet. It also
breaks the provable-fairness claim because the published server seed no longer
derives the published crash point.

**Change:**

- New `server/config/gameControls.js`. The control is **OFF by default when
  `NODE_ENV=production`** and can only be enabled with `ALLOW_MANUAL_CRASH=true`.
  Outside production it defaults on for testing and can be disabled explicitly.
- All three call sites are gated: HTTP `POST /api/admin/{crash-point,mode,clear}`
  and the socket events `setCrashPoint`, `setAdminMode`, `clearCrashPoint`.
  Denied attempts return **403** and are audited.
- Every allowed action writes `audit_logs` with the acting admin, round, value,
  transport (`http`/`socket`) and timestamp.
- `game_rounds` gains `forced`, `forced_by`, `verified`. The crash handler
  recomputes the crash point from the published seeds and stores the result.
  A mismatch logs `[fairness] CRITICAL`.
- `POST /api/game/round-details` now returns:
  - `verifiable: true, verified: <bool>` for normal rounds, and
  - `verifiable: false, reason: "operator_override", forcedBy: "..."` for a
    forced round.
- If an older database has not run the migration yet, the round insert retries
  without the audit columns rather than losing the round record.

**Operational note:** leave `ALLOW_MANUAL_CRASH` unset/false in production.

### 1.2 Server-side auto-cashout

**Threat:** auto-cashout was executed by the browser (`src/components/Main/bet.tsx`).
A backgrounded/throttled tab missed the multiplier and the player lost a bet they
had asked to cash out. The server stored `target` but never acted on it.

**Change:**

- `playBet` accepts `autoCashout` (sent by the client) and validates the target
  (`1.01 … 1000`).
- The 60 fps flying tick settles every reached target via the shared
  `settleBet()` path. `crash()` also settles targets at or below the crash point
  before marking losses, so tick granularity can never turn a winning auto
  cash-out into a loss.
- Settlement is idempotent (`bet.cashouted` is set synchronously) and rolls back
  if the ledger rejects the credit.
- The client-side effect was removed; the server pushes `myInfo`, `success` and
  the authoritative `myBetState` after settling.

### 1.3 Disconnect / reconnect accounting

**Threat:** `handleDisconnect()` deleted the player's bets without a refund.
Dropping during the betting window silently destroyed the stake; dropping during
flight erased the loss from the record.

**Change:**

- Disconnect during `BET`: the stake is refunded through the ledger
  (`BET_REFUND`) and the bet is removed.
- Disconnect during `FLYING`/`CRASHING`: the bet is kept (marked `disconnected`),
  so `crash()` still writes the loss. `rebindSocket()` re-attaches the bet to the
  new socket on `authenticate`, and the player can cash out normally.
- A per-user bet key (`userId`) now survives the socket id change.

### 1.4 Suspended accounts are blocked at the money boundary

**Threat:** banning only happened at login/socket connect. A JWT issued before
the ban stayed valid, and HTTP money routes (`POST /api/payments/deposits`,
`/withdrawals`, `/withdrawals/:id/cancel`, `POST /api/football/bet`) never
re-checked `is_banned` (CWE-613).

**Change:** new `requireActivePlayer` middleware (5-second cached lookup,
invalidated by the admin routes), composed after `requireAuth` on every
money-moving route. It uses `playerStatus.isBanned(userId, { strict: true })`:
a failed status lookup returns **503**, so a database outage cannot silently
disable suspension enforcement on deposit/withdrawal/football-bet paths. The
in-game betting path keeps the fail-open behaviour, so one failed status read
cannot stop the round for every player.

### 1.5 PayChangu settlement is verify-payment only

**Change:** the public webhook endpoint and its signing secret were removed.
Deposits are settled only by calling `verify-payment/{tx_ref}` from the
player-authenticated status endpoint. A forged browser redirect cannot mint a
deposit because the gateway must confirm the reference, currency and an amount
of at least the amount we recorded.

### 1.6 Ledger sign per reason (SCHEMA_AUDIT M-C)

`checkBucketShape()` (JS) and `apply_movement()` (SQL) now refuse a balance delta
whose sign contradicts its reason:

- positive only: `DEPOSIT`, `BET_PAYOUT`, `BET_REFUND`, `ADMIN_CREDIT`, `BONUS`
- negative only: `BET_STAKE`, `ADMIN_DEBIT`
- `ADJUSTMENT` may be either sign

### 1.7 Quick-play accounts are demo-only

`users.is_guest` (new, default `false`) is set by `/api/auth/quick-play`.
Withdrawals are refused with *"Make a deposit first to unlock withdrawals."*
The first completed deposit clears the flag (`clearGuestFlag`). The demo stake is
still playable, so the "try before you register" UX survives.

### 1.8 Broadcast redaction (CWE-200)

`bettedUserInfo` / `previousHand` now send a projection
(`publicBets()`): `name`, `userName`, `betAmount`, `cashOut`, `cashouted`,
`target`, `auto`, `autoCashout`, `type`, `img`. `userId`, `socketId`,
`stakeMinor` and `profit` no longer leave the server. The client already reads
`name`, which the old raw payload never provided.

### 1.9 Dead admin directory mounted

`routes/adminUsers.js` (list/search/edit/suspend/delete players, ledger view) was
written but never mounted. It is now mounted at `/api/admin/users` behind
`requireAdmin` + the API rate limiter. The stray `module.exports.fromMinor` was
removed.

### 1.10 Match settlement immutability (SCHEMA_AUDIT M-A)

`uq_matches_one_result` was a unique index on the primary key — a no-op. It is
replaced by `trg_football_match_settled_immutable`, which blocks changing a
match's score or settlement timestamp while `settled_at` is set. Voiding
(`settled_at -> NULL`) remains allowed.

---

## 2. Verification

```bash
# Type-check the web client
npx tsc --noEmit

# Server unit/integration tests (memory mode)
npm test --prefix server

# Production build
npx react-app-rewired build

# Ledger reconciliation (read-only). Exit 1 on any mismatch.
npm run reconcile --prefix server
```

New tests live in `server/test/hardening.test.js` (14 cases) and cover:
manual-crash gating and the admin-busy fallback, ledger sign enforcement, ban
middleware, broadcast redaction, auto-cashout (exactly once, at target, below
crash point), disconnect refund/keep, and reconnect re-binding.

`reconcile` treats an account with a non-zero balance and **no ledger rows** as a
warning, and an account whose ledger sum differs from its stored balance as a
failure. Accounts created before this pass may have an opening balance that was
written directly to `users.balance` (for example a local `data/local-db.json`
carried over from development, or an imported account). Those will be reported
until the opening balance is recorded once as an `ADJUSTMENT` ledger row. This is
the intended behaviour: an unexplained balance is exactly what the script exists
to surface. New accounts are created at zero and credited through the ledger —
including the 1,000 MWK quick-play demo stake, which is now a `BONUS` movement.

CI: `.github/workflows/ci.yml` runs the server suite and the web type-check/build
on push and pull request.

---

## 3. Deployment steps (in order)

1. **Apply the schema** to the live database:
   ```bash
   npm run db:apply --prefix server
   ```
   This adds `users.is_guest`, `game_rounds.forced/forced_by/verified`, the
   ledger sign checks, and the match-settlement trigger. The file is idempotent.
2. **Set/secrets** in the production environment:
   - `PAYCHANGU_SECRET_KEY` / `PAYCHANGU_PUBLIC_KEY` — live PayChangu credentials.
   - `JWT_SECRET` — 24+ chars, not a placeholder.
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — or `ADMIN_AUTH_MODE=db` with an admin
     row in the database.
   - Do **not** set `ALLOW_MANUAL_CRASH` in production.
3. **Restart** the API. Confirm the boot banner reports the crash-control state.
4. **Smoke test:** quick-play account → bet → auto-cashout fires server-side;
   attempt a withdrawal as a guest (should 403); suspend a test account and
   confirm deposit/withdrawal/football-bet routes return 403.
5. **Reconcile:** `npm run reconcile --prefix server` must print `OK`.

---

## 4. Remaining before a real-money launch (not code-fixable here)

- **Licensing / responsible gambling.** Operator licence, KYC/AML thresholds,
  self-exclusion, deposit limits and age verification are jurisdiction
  requirements and are not implemented. This is the single largest non-code
  blocker.
- **Live schema verification.** `SCHEMA.sql` has never been executed against a
  live Postgres/Supabase from this environment. Run `db:apply` against staging,
  then `reconcile`, before production.
- **MFA for admins.** Admin login is password-only. Add TOTP (the
  `two_factor_*` columns exist) or SSO for the operator console.
- **Withdrawal operations.** Payouts are manual. Define an approval roster,
  dual-control for large payouts, and a daily reconciliation process
  (`scripts/reconcile.js`).
- **Rate limiting is per-process.** Multi-instance deployments need a shared
  store (Redis) or sticky routing; otherwise the effective limit multiplies by
  the instance count.
- **Backups / PITR / alerting.** Off-site backups, restore drills, and alerts on
  `verified=false`, failed payouts, deposit verification failures and ledger
  mismatches.
- **Gateway go-live.** Replace test PayChangu keys and run a small-value
  end-to-end deposit/withdraw in production.
- **Product decision on quick-play.** Guests keep 1,000 MWK of demo credit and
  cannot withdraw until a real deposit. Confirm this matches the commercial
  intent. Note the conversion rule: the first completed deposit clears
  `is_guest`, so any demo winnings are withdrawable alongside the deposit. If
  that is not intended, debit the demo balance to zero (reason `ADJUSTMENT`)
  before crediting the first deposit, or track deposited vs bonus funds
  separately.
- **Step-up authentication for payout changes.** `PATCH /auth/me` can change
  `payout_phone` with only a valid session token, and the new number applies to
  the next withdrawal. A stolen token (XSS, shared device) can therefore redirect
  a future payout. Require the current password (or an OTP) to change the payout
  wallet, and alert the account owner + audit-log the change. The existing control
  only prevents a change from redirecting an already-approved payout.
- **Remaining schema-audit items.** M-B (INSERT-state bypass), M-D (dead
  `auth.uid()` policies), L-C (`after = before + delta` CHECKs) are documented in
  `SCHEMA_AUDIT.md` and not required for the fixes above.
