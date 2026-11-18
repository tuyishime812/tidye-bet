# Security Report — Aviator-Crash Platform

> **Historical document (2026-10-06).** The NetSoft Money integration described
> below was removed on 2026-10-30; PayChangu hosted checkout is now the only
> deposit gateway and automatic payouts are not configured (withdrawals are
> settled manually). References to NetSoft in this report describe the system as
> it existed at the time of the audit.

**Phase 2 scope:** Real payment flows — deposit gateway (NetSoft Money
webhook), withdrawal escrow + operator approvals, a single atomic ledger, and
the consolidated SQL schema behind them.

**Date:** 2026-10-06
**Status:** Remediation complete for all Critical/High items below. The
consolidated `SCHEMA.sql` is written and mirrored by the application layer, but
could not be executed against a live Postgres in this environment (see §5).

---

## 1. Executive summary

The betting economy did not previously have a trustworthy authorization
boundary. Several endpoints that **create or destroy real money had no
authentication at all**, and the JWT signing key had a hard-coded fallback that
is published in this repository. In the original code an unauthenticated
attacker with `curl` could mint an unlimited balance, drain any account, and
impersonate the administrator.

While adding the Football flow I closed those holes, because a betting feature
placed on top of an unauthenticated balance ledger is a liability rather than a
product. A **Critical money-math defect** was also found and fixed during
verification — it would have made the house insolvent on the first winning bet.

Phase 2 replaced the remaining **self-service deposit confirmation** (the
player could verify their own deposit, and in memory mode dictate the credited
amount from the request body) with a server-side, idempotent gateway webhook,
introduced an **escrow (held) model** for withdrawals with operator approval,
and consolidated every money movement — Aviator, football, deposits,
withdrawals, adjustments — onto **one atomic ledger function** in both storage
modes.

| Severity | Found | Fixed | Open |
| --- | --- | --- | --- |
| Critical | 4 | 4 | 0 |
| High | 8 | 8 | 0 |
| Medium | 6 | 4 | 2 |
| Low | 2 | 1 | 1 |

---

## 2. Critical

### C-1 — Unauthenticated balance mutation (money mint / account drain)

**CWE-862** Missing Authorization · **CVSS 9.8**

`POST /api/auth/deposit`, `/api/auth/withdraw` and `/api/auth/update-balance`
had **no authentication middleware at all** and took the target account from
`req.body.phoneNumber`.

```js
// BEFORE — server/routes/auth.js
router.post('/deposit', async (req, res) => {
  const { phoneNumber, amount } = req.body;   // attacker-controlled target
  ...
  const newBalance = user.balance + parseFloat(amount);
  memoryStore.addBalance(user.id, parseFloat(amount));
```

**PoC — mint money, unauthenticated, no account needed beyond a phone number:**

```bash
curl -X POST http://localhost:5001/api/auth/deposit \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"991234567","amount":999999999}'
```

**PoC — drain a victim:**

```bash
curl -X POST http://localhost:5001/api/auth/withdraw \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"<victim>","amount":999999999}'
```

Note the phone number is the *only* secret, and it is an attacker-suppliable
public identifier. Combined with the enumeration-tolerant responses, an
attacker could sweep the entire user table.

**Fix.** All three routes now sit behind `requireAdmin`, and the operator
identity plus the amount, target and reason are written to an append-only
`audit_logs` row. The player-facing alternative is a payment-gateway webhook,
which must be added before deposits can be automated (see §5, M-1).

```js
router.post('/deposit', requireAdmin, adminDepositLimiter, async (req, res) => {
  const actor = req.admin.username;             // from the verified token
  ...
  await writeAuditLog({ actor, action: 'DEPOSIT', ... });
```

**Verified:** anonymous `401`, player-token `401`, balance unchanged after both
attempts.

---

### C-2 — Hard-coded JWT signing key fallback

**CWE-798** Use of Hard-coded Credentials · **CWE-321** Hard-coded Cryptographic Key · **CVSS 9.8**

```js
// BEFORE — server/middleware/auth.js
const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-secret');
```

If `JWT_SECRET` was unset the server silently signed and verified with the
literal string `default-secret`, which is committed to this repository. Anyone
who can read the repo could forge a token for any `userId`, and the admin login
handler had the same fallback:

```bash
# forge a token for any account
node -e "console.log(require('jsonwebtoken').sign({userId:'<victim>'},'default-secret'))"
```

**Fix — fail closed at boot.** `config/auth.js` terminates the process instead of
falling back, and additionally rejects:

- length below 24 characters (warning below 32),
- known-weak values, including the ones merely *embedded* in a longer string,
- low-entropy secrets (`aaaaaaaaaaaaaaaa…`),
- **placeholder fragments** (`your-`, `change-this`, `example`, `replace`, …).

The placeholder check matters because the previous `.env.example` shipped
`JWT_SECRET=your-super-secret-jwt-key-change-this-in-production` — 46 characters,
so a length check alone accepted it, and it was published in the repo. Copying
the example file without editing it would deploy a forgeable signing key.

**Verified:** 7 subprocess boot tests (`server/test/boot.test.js`) assert the
server refuses to start for each case.

---

### C-3 — Critical: payout computed in the wrong units (100× overpay)

**CWE-682** Incorrect Calculation · **CVSS 9.1**

Found by the integration test, not by review — it is exactly the kind of defect
that review misses.

`stakeMinor` is in **minor units** (`stake × 100`) and `oddsMinor` is in **basis
points** (`odds × 100`). The product carried both `×100` scales and was never
converted back:

```js
// BEFORE — server/config/footballStore.js
potentialReturnMinor: stakeMinor * oddsMinor,   // 100x too large
```

`settleMatch()` credits that field **verbatim**, so the error reached real
balances. A 1000 MWK bet at 2.06 returned **206 000 MWK** instead of 2 060 MWK:

```
bet placed       -> 200 odds=2.06 potential=206000 balance=4000
settle 3-1 (HOME) -> 200 outcome=HOME winners=1 paid=206000
```

One winning bet bankrupts the house, and any player can cause it deliberately by
betting a selection they expect to win.

**Fix.** Convert one scale out, with the algebra documented inline so it cannot
be "simplified" away again, plus a tripwire that throws if the invariant breaks:

```js
// stakeMinor = stake x 100, oddsMinor = odds x 100
// decimal multiplier = oddsMinor / 100
potentialReturnMinor = Math.round((stakeMinor * oddsMinor) / 100);

const MAX_ODDS_BP = 100_000;                       // 1000.00x
if (potentialReturnMinor <= stakeMinor ||
    potentialReturnMinor > stakeMinor * MAX_ODDS_BP) {
  throw new Error('createBet: payout invariant violated - check minor-unit math');
}
```

**Verified:** 16 tests in `server/test/money.test.js` pin the conversion across
odds from 1.01× to 101× and at the maximum stake; live settlement now returns
exactly `stake × odds` (5000 → 4000 → 6600 for a 1000 MWK stake at 2.60).

---

### C-4 — Deposit "verification" was player-callable and amount-blind

**CWE-20** Improper Input Validation · **CWE-862** Missing Authorization · **CVSS 9.5**

The legacy payment route (`server/routes/payment.js`, now deleted) let the
**player** confirm their own deposit:

```js
// BEFORE — POST /api/payment/verify-deposit (any authenticated player)
const { token, notificationCode, amount } = req.body;
if (notificationCode !== netsoftConfig.SUCCESS_CODE) { ... }   // player supplies 2029
// memory mode:
const depositAmount = parseFloat(amount) || 0;   // credited amount comes from the CLIENT
memoryStore.updateBalance(localUser.id, currentBalance + depositAmount);
```

Two compounding flaws:

1. **Self-service confirmation.** The gateway never attests to anything. Any
   player who initiated a deposit could call `verify-deposit` with `2029` and
   get credited without paying. That is a money-mint primitive.
2. **Client-supplied amount.** In memory mode the credited value was read
   straight from `req.body.amount` — the initiating deposit record was ignored.
   A player could initiate a 1 MWK deposit, then "verify" it for
   9 999 999 MWK.

**PoC (memory mode):**

```bash
curl -X POST http://localhost:5001/api/payment/initiate-deposit \
  -H "Authorization: Bearer $PLAYER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"amount":1}'
# token=T1241... (also a chatty Math.random token, see M-5)
curl -X POST http://localhost:5001/api/payment/verify-deposit \
  -H "Authorization: Bearer $PLAYER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"token":"T1241...","notificationCode":2029,"amount":9999999}'
# "Deposit successful! 9999999 MWK added to your balance."
```

**Fix.** Verification now happens server-side in a gateway webhook
(`POST /api/payments/netsoft/callback`) that: looks up the WE-issued PENDING
deposit by token; rejects unless `business_number` matches *our configured
business number*; normalizes and compares the gateway amount **exactly** in
minor units; refuses any token already terminal (a FAILED deposit can never be
re-credited later — verified in integration); and credits through the ledger so
a concurrent withdrawal/bet cannot race it. The old `/api/payment/*` routes
were removed and the router is mounted at `/api/payments`.

**Verified (live, 33/33 integration checks in `verify-payments.mjs`):**
unauthenticated callback → 401; junk token → 404; wrong business number →
rejected, not credited; declined code → FAILED, not credited; underpayment →
rejected; exact-amount success → credited once; **replay of the same token →
no second credit**; a later callback for a FAILED token → still no credit.

---

## 3. High

### H-1 — Socket.IO `playBet` had no authentication

**CWE-306** Missing Authentication · **CVSS 8.1**

`socket.on('playBet', data => game.placeBet(socket, data))` trusted the client
payload with no check that the socket was authenticated, so the wagering path
that actually moves money in the crash game was reachable by an unauthenticated
socket client.

**Fix.** `playBet`, `cashOut` and `sendMsg` now require `socket.userId`, which is
bound from the verified JWT at connection time. Chat identity (`userId`,
`userName`, `avatar`) is taken from the socket and **ignored from the payload**,
closing impersonation. Per-event rate limiters were added.

### H-2 — IDOR on `/api/game/my-info`

**CWE-639** Authorization Bypass Through User-Controlled Key · **CVSS 7.5**

The handler took the account name from the request body, letting any caller read
any player's record.

**Fix.** `requireAuth` + owner resolved from the verified token; the `name` field
is ignored entirely.

### H-3 — Mass assignment / IDOR in `/api/auth/user-info`

**CWE-915** · **CVSS 7.5**

Callers could pass an arbitrary `userId` and read another account.

**Fix.** Replaced with `GET /api/auth/me` and `PATCH /api/auth/me`. `PATCH` uses
an **allow-list** of mutable fields, so an attacker cannot escalate by supplying
`balance`, `id` or `is_admin`; unknown keys are ignored rather than assigned.

### H-4 — CORS allowed any `*.vercel.app` / `*.onrender.com`

**CWE-942** Permissive Cross-domain Policy · **CVSS 7.4**

```js
// BEFORE
/\.vercel\.app$/,   // Allow all Vercel apps
/\.onrender\.com$/  // Allow all Render apps
```

Any anonymous actor can stand up `https://evil.vercel.app` in ~30 seconds and
call this API from a browser, with the victim's cookies attached.

**Fix.** Exact-origin matching against `FRONTEND_URL` / `ADMIN_SITE_URL`, plus
genuine-subdomain matching. Subdomain matching is scoped to the *configured
host* so `https://x.vercel.app` cannot impersonate `https://y.vercel.app`; note
that configuring a bare apex domain therefore implies trusting all of its
subdomains, which is the intended trade-off for Vercel previews. A rejected
origin now returns **403 with a terse body** rather than a 500 that looked like
a platform outage and could be used as an allow-list discovery oracle.

**Verified:** `Origin: https://evil.vercel.app` → `403`;
`Origin: http://localhost:3000` → `200`.

### H-5 — Privilege confusion between user and admin tokens

**CWE-269** Improper Privilege Management · **CVSS 7.5**

A single `verifyToken()` accepted any signed token, so an **admin token would
satisfy player routes** — one token confused for another privilege level.

**Fix.** Token namespaces. `signUserToken` sets `typ:'user'`; the admin login sets
`typ:'admin'` + `isAdmin:true`. `verifyUserToken` requires `typ === 'user'` and
rejects `isAdmin`; `verifyAdminToken` requires `typ === 'admin'` **and**
`isAdmin === true`. Both pin `algorithms: ['HS256']`.

**Verified:** 13 tests in `server/test/auth.test.js`, including cross-namespace
replay, `alg:none` (CWE-347), HS384 algorithm substitution, tampered payloads,
and expiry.

### H-6 — Permissive RLS: `USING (true)` on the money tables

**CWE-284** Improper Access Control · **CVSS 8.1** (database layer)

The previous schema enabled row-level security with permissive policies of the
form `CREATE POLICY "Allow all operations ..." ON users FOR ALL USING (true)`,
so any authenticated client with the *browser* Supabase key could read and
**write every user's balance, every deposit, every withdrawal** directly through
the PostgREST API — completely outside the Express layer's authorization.

**Fix.** `SCHEMA.sql` now: drops all legacy `USING (true)` policies
(programmatically, from `pg_policy`); grants every write to `service_role`
only; `REVOKE UPDATE (balance, held) ON users FROM anon, authenticated`;
exposes `apply_movement()` to `service_role` only; and replaces permissive
policies with owner-scoped `SELECT ... USING (auth.uid() = user_id)` on
`users`, `football_bets`, `deposits`, `withdrawals`, and `balance_ledger`
(`football_matches` stays readable by all). A client key can therefore never
move money — it can only read its own rows.

### H-7 — Dual balance mechanism double-counted escrowed funds

**CWE-682** Incorrect Calculation · **CVSS 8.1**

The first withdrawal design kept two "available balance" notions in flight:
`balance` was *not* decremented by a hold, while "available" was computed as
`balance - held` at some call sites **and** as plain `balance` at others
(football's `adjustBalance`, the Aviator game, the ledger helpers). Every
`balance >= stake` check that forgot the subtraction let a player wager money
that was already promised to a pending withdrawal — and a player with a pending
withdrawal could *re-wager the same money repeatedly* against every check.

**Fix — disjoint escrow (Model B).** A hold now **moves** money out of
`balance` into `held`: `placeHold` does `balance −X, held +X`, so "available"
is definitionally `balance` and **no subtraction can be forgotten anywhere**.
`refundHold` returns `X` to `balance`; `releaseHold` (payout confirmed)
consumes `held` only. One atomic `apply_movement()` in SQL and a mirror
implementation in `services/ledger.js` enforce the per-reason bucket shape, and
`balance >= 0`, `held >= 0` are hard constraints in both modes.

**Verified:** ledger unit suite (`server/test/payments.test.js`) covers the
hold → refund → release lifecycle, refusal of mis-shaped movements
(`WITHDRAWAL_HOLD` with a positive balance delta, `WITHDRAWAL_PAID` touching
balance, escrow movement under `BET_STAKE`, unknown reasons), and 25 concurrent
debits against 1000 MWK — exactly 5 succeed, balance lands on exactly zero.

### H-8 — Football and Aviator money paths bypassed the ledger

**CWE-362** Race Condition (TOCTOU) · **CVSS 7.5**

`footballService.adjustBalance` and the Aviator `gameLogic` socket handlers
still carried the legacy dual-mode code: in Supabase mode they did
**read-balance → compute → write-balance** across awaits (a classic
double-spend race on concurrent bets) and in memory mode they mutated
`memoryStore` directly — no FIFO lock, no ledger row, no audit trail. One
football branch even called the deleted `apply_balance_delta` RPC, which no
longer exists in `SCHEMA.sql`.

**Fix.** Both games now move money exclusively through `services/ledger.js`
(per-user FIFO queue in memory mode, `apply_movement` row lock in Postgres
mode, ledger row written in the same critical section). Bet stake rows carry
`BET_STAKE` and reference the bet id (minted *before* the debit, bet persisted
only *after* the money moves); settlements credit `BET_PAYOUT`; voids credit
`BET_REFUND`. `adjustBalance` still exists in footballService for call-site
stability, but it is now a thin validator on top of the ledger that **refuses
unsigned debits** — the old `requireSufficientFunds: false` overdraw path
cannot express itself.

**Verified live (`verify-football.mjs`, 13/13):** bet → `BET_STAKE` row with
`bet:<id>` reference → settle → exactly `stake × odds` credited → `BET_PAYOUT`
row with the same reference → repeat settle refused (no double payout) →
statement delta sum equals final balance.

---

## 4. Medium & Low

| ID | Issue | CWE | Status |
| --- | --- | --- | --- |
| M-1 | No payment-gateway webhook, so deposits were manual via admin | — | **Fixed** — verified NetSoft webhook (`/api/payments/netsoft/callback`), see C-4 |
| M-2 | User enumeration: register/login revealed whether a phone number exists | CWE-204 | **Fixed** — dummy bcrypt compare on unknown users so timing and message match |
| M-3 | `toMinor()` used blind `Number()` coercion: `true` → `1`, `[500]` → `500`, `null` → `0` | CWE-20 | **Fixed** — strict numeric/decimal-string allow-list; `null` is rejected, never coerced to 0 |
| M-4 | Audit log silently discarded when the model's datastore was disconnected | CWE-778 | **Fixed** — see below |
| M-5 | Deposit tokens were generated with `Math.random()` | CWE-338 | **Fixed** — see below |
| L-1 | Verbose errors leaked internals; admin password compared non-constant-time | CWE-209 / CWE-208 | **Fixed** — generic messages, `safeCompare()` SHA-256 + `timingSafeEqual` |
| L-2 | Quick Play guest accounts were unmetered free money | CWE-770 | **Fixed** — retained per product decision, capped at 3/hour/IP |

### M-4 — Audit log depended on a silently-disconnected datastore

**CWE-778** Insufficient Logging · **CVSS 5.3**

Legacy audit calls went through mongoose models (`AuditLog.create(...)`,
`models/` directory) backed by a Mongo connection that **this server never
opens** — every audit write resolved quietly without persisting anything.
Attributability (who credited whom, why, from which token) was therefore
fiction in both storage modes.

**Fix.** The mongoose models are deleted. `services/audit.js` writes through
the Supabase client when connected **and** a bounded in-memory ring buffer
always — in `USE_SUPABASE=false` mode audit rows are kept in memory (like the
rest of the local store) and the withdrawal/credit endpoints now audit every
transition: requested, approved, rejected, cancelled, paid, adjustment, and
webhook. `routes/payments.js` had a broken `const { writeAuditLog } =
require('../services/audit')` import before Phase 2 verification; fixed.

### M-5 — Predictable deposit transaction tokens

**CWE-338** Use of Cryptographically Weak PRNG · **CVSS 4.3**

`netsoftConfig.generateToken()` used `Math.random()`, so deposit tokens were
guessable/enumerable. An attacker who predicted an *initiated but unpaid*
deposit token could race the player's callback and claim the credit first (or
probe already-issued tokens in a replay attempt).

**Fix.** Token generation now lives in `services/netsoft.js` and draws 128 bits
from `crypto.randomBytes` (`D-` + 16 hex bytes). The legacy `Math.random`
generator in `config/netsoft.js` was **neutralized to throw** with a pointer to
the secure implementation, so any future caller reintroducing the weak path
fails loudly at runtime instead of silently weakening the webhook.

### Phase 2 hardening

- **Single ledger choke point:** `apply_movement(user_id, balance_delta,
  hold_delta, reason, ...)` is the *only* function that can change `balance` /
  `held` — in SQL (`service_role`-only, `REVOKE UPDATE` on the columns for
  `anon`/`authenticated`) and in `services/ledger.js` (per-user FIFO queues).
  Games, deposits, withdrawals and admin adjustments all route through it.
- **Escrow vocabulary is enforced:** the helper functions pin their reason
  (`credit → DEPOSIT/BET_PAYOUT/…`, `placeHold → WITHDRAWAL_HOLD`,
  `refundHold → WITHDRAWAL_REFUND`, `releaseHold → WITHDRAWAL_PAID`), and the
  bucket-shape validator rejects any mislabeled movement before it touches
  storage, in both modes.
- **Withdrawal destination is immutable-by-design:** a withdrawal request can
  never introduce a phone number; it resolves the user's registered
  `payout_phone` server-side and sends only there. `PATCH /auth/me` allows the
  field to change, but a changed number applies to *next* withdrawals only —
  an approved payout can never be redirected mid-flight.
- **Approval cannot double-pay:** payout is attempted by the gateway *before*
  the state moves to `PAID`; a non-confirming gateway returns
  `503 PAYOUT_NOT_CONFIGURED` with `fundsStillHeld: true` and the hold stays
  intact. `settleHold` consumes `held` only after a positive gateway
  confirmation, so `held` never inflates permanently.
- **Idempotent, terminal deposits:** a webhook replay for a COMPLETED deposit
  is ignored; a FAILED deposit is terminal and can never be re-credited later.
- **Statement endpoint:** `GET /api/payments/statement` returns the append-only
  per-user ledger with amounts in MWK major units (passthrough via `Number()`,
  never re-converted).

---

### Rate limiting was silently inert

`app.use('/api/auth', apiLimiter(), ...)` **constructed a new limiter inside the
request handler** on every request. Two consequences: `express-rate-limit`
rejected it outright (`ERR_ERL_CREATED_IN_REQUEST_HANDLER`, which surfaced as
registration failures during testing), and a per-request limiter can never
accumulate a count. All limiters are now built once at module load and passed as
instances (`apiRateLimit`, `registerLimiter`, `loginLimiter`, `adminLoginLimiter`,
`betLimiter`, socket event limiters). Also added `express.json({ limit: '16kb' })`
so a large body cannot be used to exhaust memory before validation.

### Other hardening

- **Password storage:** bcrypt cost raised to 12; policy requires ≥8 characters
  with a letter and a number.
- **Double settlement:** blocked in application code *and* by a database trigger
  (`guard_bet_settlement`), so a race or a manual DB write still cannot pay twice.
- **Money as integers:** balances, stakes, odds and payouts are integer minor
  units / basis points end to end; no floating-point accumulation in the ledger.
- **Atomic movement:** a single stored function (`apply_movement`, successor to
  the Phase 1 `apply_balance_delta`) moves balance and/or held in one row-locked
  statement, preventing double-spend under concurrent requests.
- **Security headers:** CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options`,
  and a JSON 404 handler for `/api`.
- **Frontend XSS:** the new `AuthGate` renders every server message as a text
  node, never `innerHTML`/`dangerouslySetInnerHTML`.
- **Dead code removed:** `DepositModal.tsx` implemented a self-service wallet
  against the now admin-only endpoints and could never succeed.

---

## 5. Open items — action required before production

### R-1 — `server/SCHEMA.sql` has not been executed against a live Postgres

This environment has **no reachable Postgres runtime**: no network access, no
`psql`, no Docker, and the PGlite fallback fails with `ECONNRESET`. Everything
in `SCHEMA.sql` and the Supabase-mode code paths is therefore written but
**unexecuted and unverified**. Two consequences:

1. **Memory mode is what runs today** (`USE_SUPABASE=false`): balances, bets,
   deposits, withdrawals and audit rows live in process memory and are lost on
   restart. The `apply_movement` RPC, RLS policies, triggers and unique
   constraints are *not* exercised locally — the application layer mirrors
   their invariants (per-user FIFO queues, shape validators, terminal-state
   guards) and those mirrors are fully tested, but a real Postgres run is still
   the only proof the SQL itself is correct.
2. Before any real money moves, apply `server/SCHEMA.sql` to the Supabase
   project, set `USE_SUPABASE=true` **and** `SUPABASE_SERVICE_ROLE_KEY` (the
   service-role key, distinct from the browser `SUPABASE_KEY` — every money
   write uses the service role), then re-run the full integration scripts
   against a DB-backed server.

### R-2 — Gateway signature verification is stubbed for the sandbox

The NetSoft webhook is reachable and every amount/business/state check is
enforced and verified, but the **request-signature verification is a
placeholder** (`services/netsoft.js` documents the hook point); NetSoft's
sandbox is not reachable from this machine to capture a real signed request.
Before production, pin the signature scheme (`raw body → HMAC`, constant-time
compare) from NetSoft's spec and keep the existing checks — the webhook already
ignores the body's `amount` entirely and matches against the recorded deposit,
so a signature bypass would still need a valid initiated token.

### R-3 — Frontend rendering is unverified in a real browser

No desktop browser is attached to this session. The frontend compiles and
type-checks (`tsc --noEmit`, `npm run build`), and the API contract it calls is
verified end-to-end from scripts, but the Wallet, Admin console and game-chooser
screens have not been clicked through in a browser. Open
`http://localhost:3000` (dev servers are running) and walk: lobby → football
(browse matches) → place a bet (login gate) → Wallet (deposit + withdrawal) →
`/admin` (approve the withdrawal, settle the match).

### R-4 — `package-lock.json` still lists removed dependencies

`mongoose`, `crypto-js`, `speakeasy`, `qrcode` were removed from
`server/package.json` but the lockfile could not be regenerated offline
(`npm install --package-lock-only` needs the registry). Run
`npm install --package-lock-only` (or `npm i`) with network access in
`server/` — until then `npm ci` will complain.

### Also confirm

- **Rotate `JWT_SECRET`** to a fresh 48-byte random value; setting it invalidates
  all existing sessions. Generate with
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
- **`ADMIN_PASSWORD` must be ≥12 characters**; the dev value in `server/.env`
  is a placeholder and must be replaced (and the admin credentials rotated if
  `server/.env` ever left the machine).
- **NetSoft config** in `server/.env`: `NETSOFT_BUSINESS_NUMBER`,
  `NETSOFT_BUSINESS_NAME`, `NETSOFT_ENVIRONMENT=test` — the callback rejects
  anything that does not match the configured business number. The UI's
  "pay this number" panel is a static display string; make it server-driven
  (`GET /api/payments/config`) before launch so the number shown always
  matches the number verified.
- Confirm `.env` is git-ignored and never committed (the *values* in
  `server/.env.example` are placeholders by design).

---

## 6. Tests

```bash
cd server
npm test              # 69 tests — money, auth, boot, ledger/escrow, payments
npm run test:money    # 16 — minor-unit + payout algebra
npm run test:auth     # 13 — privilege boundary, forgery resistance
npm run test:boot     #  7 — fail-closed boot validation
cd ..
npx tsc --noEmit      # clean
npm run build         # compiles
```

These exist because the Critical defect in §C-3 was **not** found by reading the
code — it was found by asserting on settlement arithmetic end to end. The money
algebra is the highest-value thing to keep covered.

Phase 2 adds a ledger suite (`payments.test.js`) because the escrow model
(hold → refund → release, mis-shape refusal, concurrent-debit racing) is the
new highest-value invariant: if `balance` ever stops excluding `held`, every
spend check in the app silently double-counts.

**Live end-to-end suites** (run against the server on :5001, memory mode —
kept in `%LOCALAPPDATA%\Temp\opencode\` because they need a running server):

```bash
node verify-payments.mjs   # 33/33 — auth 401s, webhook happy/junk/wrong-biz/
                           # declined/underpay/replay/failed-terminal, holds,
                           # admin approve/reject, cancel, double-decision,
                           # statement reconciliation
node verify-football.mjs   # 13/13 — deposit → football bet (BET_STAKE row w/
                           # bet ref) → admin settle → exact stake×odds payout
                           # (BET_PAYOUT row) → idempotent re-settle → statement
                           # sum == final balance
```

---

## 7. Security diff summary

| Area | Before | After |
| --- | --- | --- |
| Balance mutation | Unauthenticated, body-supplied target | Admin-only + audit log |
| Deposit confirmation | Player self-verifies, client-supplied amount (C-4) | Server-side webhook: business+amount match, idempotent, terminal states |
| JWT secret | `|| 'default-secret'` fallback | Fail-closed at boot, placeholder/entropy checks |
| Token verification | One generic verifier | Namespaced `typ`, HS256 pinned, `alg:none` blocked |
| Admin login | Fallback creds, `===` compare | Fail-closed creds, `timingSafeEqual` |
| Socket wagering | No auth, payload identity | JWT-bound identity, rate limited |
| `/my-info` | IDOR | Owner from token |
| `/user-info` | IDOR + mass assignment | Allow-listed `/me` |
| CORS | Any Vercel/Render subdomain | Exact origin + true subdomains |
| Rate limiting | Built per-request (inert) | Built once at boot |
| Money | Float, wrong scale | Integer minor units, invariant-checked |
| Body size | Unbounded | 16 KB cap |
| Passwords | Weak policy | bcrypt cost 12, 8+ chars, letter + number |
| Enumeration | Distinct messages/timing | Uniform message + dummy compare |
| RLS (DB layer) | `USING (true)` on money tables (H-6) | Owner-scoped SELECT; writes `service_role`-only; `REVOKE UPDATE (balance,held)` |
| Money movement | 2+ RPCs / raw row writes, read-modify-write races | One `apply_movement` + mirrored `services/ledger.js` FIFO; games included (H-7/8) |
| Withdrawal funds | Ambiguous dual "available" models (double-count) | Disjoint escrow: hold moves `balance → held`; `available == balance`, always |
| Deposit tokens | `Math.random()` (M-5) | 128-bit `crypto.randomBytes`; legacy generator throws |
| Audit trail | Mongoose models on a connection the server never uses (M-4) | Supabase + in-memory ring buffer, every money event logged |
| Payout approval | — | Payout-first, `fundsStillHeld` on failure, `held` released only on positive confirmation |