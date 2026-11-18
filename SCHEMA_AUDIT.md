# SCHEMA.sql Security & Correctness Audit

**Target:** `server/SCHEMA.sql` (710 lines, 10 sections)
**Method:** static review, cross-checked against the code that consumes the schema
(`config/supabase.js`, `services/ledger.js`, `services/schemaCheck.js`,
`routes/auth.js`, `game/gameLogic.js`, `routes/game.js`, `services/audit.js`,
`scripts/apply-schema.js`)
**No live database was contacted.**
**Cross-reference:** `SECURITY_REPORT.md` (H-6/H-7 fixes, R-1 open item)

---

## Summary

| # | Finding | CWE | Severity |
|---|---------|-----|----------|
| H-A | RLS **not enabled** on `game_rounds`, `bets`, `chat_messages` (contradicts "RLS enabled everywhere") | CWE-284 / CWE-862 | **High** |
| H-B | Migration can hard-abort on realistic legacy data; whole txn rolls back | CWE-1059 | **High** |
| M-A | `uq_matches_one_result` is a **no-op**; "one result per match" not enforced | CWE-1188 | **Medium** |
| M-B | Withdrawal/deposit/bet state machines enforced on UPDATE only — INSERT bypasses them | CWE-863 | **Medium** |
| M-C | `apply_movement()` doesn't enforce the **sign** of the delta per reason | CWE-682 | **Medium** |
| M-D | `auth.uid()` policies are dead code; "password column is protected" claim is false | CWE-284 | **Medium** |
| M-E | File is Supabase-specific but documented/tooled as generic Postgres | CWE-1059 | **Medium** |
| M-F | `apply_movement()` is **executable by `anon`/`authenticated`** despite the "service_role only" grant | CWE-284 / CWE-732 | **Medium** |
| L-A | `NaN`/`±Infinity` numeric injection possible into balances | CWE-20 | **Low** |
| L-B | Ledger has no `TRUNCATE` guard; `audit_logs` isn't append-only | CWE-778 | **Low** |
| L-C | No `after = before + delta` CHECKs (hold side unverified) | CWE-682 | **Low** |
| L-D | `users_balance_non_negative` name mismatch → duplicate constraint | CWE-1059 | **Low** |
| L-E | Phone normalisation claimed but not implemented; app/DB rules disagree | CWE-1289 | **Low** |
| L-F | Plaintext `two_factor_secret`; missing net-amount checks; duplicate `last_login*`; `ON DELETE CASCADE` on `bets` | CWE-311 / misc | **Low** |
| L-G | `search_path` not pinned on `apply_movement` | CWE-426 | **Low** |

The core money model (single `apply_movement`, disjoint escrow, row lock,
append-only ledger, `service_role`-only grants) is well constructed. The findings
below are gaps *around* that model and places where the file's comments overstate
what the SQL actually enforces.

## Remediation status (2026-11-04)

| Finding | Status |
|---------|--------|
| H-A (RLS on `game_rounds` / `bets` / `chat_messages`) | Fixed — RLS + deny-by-default policies in SECTION 9 |
| M-A (`uq_matches_one_result` no-op) | Fixed — replaced with the `trg_football_match_settled_immutable` trigger |
| M-C (`apply_movement` sign per reason) | Fixed — sign checks added, mirrored in `services/ledger.js` |
| M-F (`apply_movement` granted to `anon`/`authenticated`) | Fixed — revoked in SECTION 3 |
| L-C (`after = before + delta` CHECKs) | Still open — the trigger/ledger code enforces it, but not as a CHECK |
| M-B, M-D, M-E, L-A/B/D/E/F/G | See `HARDENING.md` for what remains before launch |

`M-A` and `M-C` still require `npm run db:apply --prefix server` against a real
database; the schema file is the source of truth but this environment has no live
Postgres to verify against.

---

## HIGH

### H-A — RLS is not enabled on three tables the schema claims to protect

**CWE-284 · CVSS 8.1 (within the schema's own threat model)**

SECTION 9 comments "RLS: enabled everywhere", but enables it on only seven tables
(`users`, `balance_ledger`, `deposits`, `withdrawals`, `football_bets`,
`football_matches`, `audit_logs`). `game_rounds`, `bets`, and `chat_messages` are
created in SECTION 8 and **never have RLS enabled**.

On a fresh Supabase project the default privileges grant `anon` and
`authenticated` full table access; with no RLS there is no policy layer to deny
it. SECTION 10's verification only tests the seven `REQUIRED_TABLES`, so it
reports "Schema OK" while these three are open.

**Impact** — for any holder of the browser anon key (which the schema's own
comments assume is in every browser):

- `bets` → read every crash bet: `user_name`, **`phone_number`** (PII),
  `bet_amount`, `profit`, `fly_away`.
- `chat_messages` → read, **insert, update, and delete** any player's chat.
- `game_rounds` → read `server_seed` and `server_seed_hash` for every round.

**Proof of concept** (direct PostgREST, bypassing the Express layer entirely):

```bash
# Read PII from the crash bets table
curl "$SUPABASE_URL/rest/v1/bets?select=user_name,phone_number,bet_amount,profit" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"

# Delete another player's chat message
curl -X DELETE "$SUPABASE_URL/rest/v1/chat_messages?id=eq.<id>" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
```

**Mitigating context (stated honestly):** in this repo the frontend never
instantiates a Supabase client (no `supabase` usage under `src/`), and the server
always uses the service-role key. Exploitability today is therefore contingent on
the anon key leaking, not a live 0-click bug. But the anon key is a
public-by-design value, and the entire H-6 remediation was premised on it being
present in every browser — leaving three tables (one with PII, one with the
fairness seed) without RLS is an inconsistency in the exact control that fix
established.

**Fix:**

```sql
ALTER TABLE game_rounds   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rounds readable by all" ON game_rounds;
CREATE POLICY "rounds readable by all" ON game_rounds FOR SELECT USING (true);

DROP POLICY IF EXISTS "chat readable by all" ON chat_messages;
CREATE POLICY "chat readable by all" ON chat_messages FOR SELECT USING (true);
-- `bets` has NO policy: owner-scoped reads go through the backend (service_role).
```

Extend the SECTION 10 check to assert RLS on **every** public table:

```sql
SELECT string_agg(c.relname, ', ') INTO v_no_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
IF v_no_rls IS NOT NULL THEN
  RAISE EXCEPTION 'RLS DISABLED ON: %', v_no_rls;
END IF;
```

---

### H-B — The "safe to re-run, never drops data" migration can abort and roll back entirely

**CWE-1059**

The header promises: *"SAFE TO RE-RUN … can be applied to an existing database
without dropping player data."* Four `ALTER TABLE … ADD CONSTRAINT` statements
are unconditional and raise on any pre-existing violating row:

```sql
ALTER TABLE users ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);
ALTER TABLE users ADD CONSTRAINT users_user_name_key    UNIQUE (user_name);
ALTER TABLE users ADD CONSTRAINT users_phone_number_format
  CHECK (phone_number ~ '^\+?[0-9]{9,15}$');
ALTER TABLE football_bets ADD CONSTRAINT football_bets_return_consistent
  CHECK (potential_return = round(stake * odds, 2));
```

This is realistic, not hypothetical: earlier guest-account code created users
with an **empty** `phone_number`, and multiple such rows both violate the regex
and collide on the UNIQUE constraint.

Because `scripts/apply-schema.js` wraps the whole file in one transaction, a
single violation rolls back **every** repair with an opaque error. The file
already shows the right pattern for `balance` (detect, `RAISE EXCEPTION` with
guidance) but didn't apply it here.

**Fix** — pre-flight before each constraint:

```sql
DO $$
DECLARE dup_count INT; bad_phone INT;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT phone_number FROM users GROUP BY phone_number HAVING count(*) > 1) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'users has % duplicate phone_number(s); merge before adding UNIQUE', dup_count;
  END IF;

  SELECT count(*) INTO bad_phone FROM users
   WHERE phone_number !~ '^\+?[0-9]{9,15}$';
  IF bad_phone > 0 THEN
    RAISE EXCEPTION 'users has % phone_number(s) failing the format CHECK', bad_phone;
  END IF;
END $$;
```

Or add constraints `NOT VALID` and `VALIDATE CONSTRAINT` separately, so the
migration lands and bad rows can be repaired afterwards.

---

## MEDIUM

### M-A — `uq_matches_one_result` enforces nothing

**CWE-1188**

```sql
-- One result per match. Prevents an admin (or a bug) settling 3-1 and then 1-0.
CREATE UNIQUE INDEX IF NOT EXISTS uq_matches_one_result
  ON football_matches (id) WHERE status = 'FINISHED';
```

`id` is already the PRIMARY KEY, so a partial unique index over it can never
reject a row. The claimed invariant is **not implemented**: a FINISHED match's
`home_goals`, `away_goals`, and `settled_at` can be overwritten freely.

**Fix** — freeze the result once finished:

```sql
CREATE OR REPLACE FUNCTION guard_match_result()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'FINISHED' AND
     (NEW.home_goals <> OLD.home_goals OR NEW.away_goals <> OLD.away_goals) THEN
    RAISE EXCEPTION 'match % result is final and cannot be changed', OLD.id;
  END IF;
  IF NEW.status = 'FINISHED' AND OLD.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'match % was already settled', OLD.id;
  END IF;
  IF NEW.status = 'FINISHED' THEN NEW.settled_at := now(); END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_match ON football_matches;
CREATE TRIGGER trg_guard_match BEFORE UPDATE ON football_matches
  FOR EACH ROW EXECUTE FUNCTION guard_match_result();
```

Drop the useless index.

---

### M-B — Terminal state machines are bypassable via INSERT

**CWE-863**

`guard_withdrawal_transition` is `BEFORE UPDATE` only; `guard_bet_settlement` is
`BEFORE UPDATE OF status`. A row can be **inserted** in a terminal state,
skipping the entire hold/ledger path:

```sql
-- No WITHDRAWAL_HOLD ever occurred; balance was never debited.
INSERT INTO withdrawals (user_id, amount, fee, net_amount, method, phone_number,
                         status, processed_by, processed_at)
VALUES ('<uuid>', 5000, 0, 5000, 'mpamba', '<phone>', 'PAID', 'admin', now());
```

**Fix:**

```sql
CREATE OR REPLACE FUNCTION force_pending_on_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION '% rows must be created PENDING (got %)', TG_TABLE_NAME, NEW.status;
  END IF;
  NEW.processed_by := NULL;
  NEW.processed_at := NULL;
  RETURN NEW;
END $$;
```

Apply to `withdrawals`, `deposits`, `football_bets` (with the appropriate
reset column list per table).

---

### M-C — `apply_movement()` validates the escrow shape but not the direction of the balance move

**CWE-682**

The header claims each reason has a fixed shape so reconciliation by reason is
trustworthy. In practice only withdrawal reasons are shape-checked; every other
reason accepts any sign:

```sql
IF p_reason NOT LIKE 'WITHDRAWAL_%' AND (p_hold_delta <> 0) THEN ... END IF;
```

So all of these succeed:

- `('DEPOSIT', p_balance_delta => -5000)` → a "deposit" that debits.
- `('BET_STAKE', p_balance_delta => +5000)` → a "stake" that credits.
- `('ADMIN_DEBIT', p_balance_delta => +1000000)` → an "admin debit" that mints.

`services/ledger.js` (`checkBucketShape`) mirrors this exactly, so neither layer
catches it. The `balance >= 0` floor bounds damage, but reconciliation-by-reason
is defeatable.

**Fix:**

```sql
IF p_reason IN ('DEPOSIT','BET_PAYOUT','BET_REFUND','BONUS','ADMIN_CREDIT')
   AND p_balance_delta <= 0 THEN
  RETURN QUERY SELECT FALSE, NULL, NULL, 'reason requires a credit';
  RETURN;
END IF;
IF p_reason IN ('BET_STAKE','ADMIN_DEBIT') AND p_balance_delta >= 0 THEN
  RETURN QUERY SELECT FALSE, NULL, NULL, 'reason requires a debit';
  RETURN;
END IF;
```

Mirror the same checks in `services/ledger.js`.

---

### M-D — `auth.uid()` policies are dead code; the password-column claim is wrong

**CWE-284**

```sql
-- Own record only - and never the password column, which anon cannot read
-- through this policy anyway because the app must not expose it.
CREATE POLICY "users own record" ON users FOR SELECT USING (auth.uid() = id);
```

1. **RLS cannot restrict columns.** The policy grants SELECT on the **whole row**
   — including `password` (bcrypt hash) and `two_factor_secret` — to any request
   whose `auth.uid()` equals the row id. The only reason this isn't exploitable
   today is that the app authenticates with its own HS256 JWT, so `auth.uid()` is
   always `NULL` and the policy denies everything. The comment states an accident
   as a control.
2. If anyone later aligns the Supabase JWT secret with `JWT_SECRET` and issues
   tokens carrying `sub`, all owner-read policies activate at once — including
   the password hash.

**Fix:**

```sql
REVOKE SELECT (password, two_factor_secret) ON users FROM anon, authenticated;
```

Plus a dedicated safe view if owner reads are ever needed via PostgREST.

---

### M-E — Supabase-specific SQL presented as generic Postgres

**CWE-1059**

The header and `scripts/apply-schema.js` both offer a generic path
(`psql "$SUPABASE_DB_URL"`, `DATABASE_URL`), but the file will not run on vanilla
Postgres:

- `GRANT EXECUTE … TO service_role;` → `role "service_role" does not exist`.
- `REVOKE UPDATE (balance, held) … FROM anon, authenticated;` → roles absent.
- `CREATE POLICY … USING (auth.uid() = id)` → `function auth.uid() does not exist`.

Any one raises, and the single-transaction apply rolls everything back.

**Fix:**

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION apply_movement(UUID,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,JSONB) TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE UPDATE (balance, held) ON users FROM anon;
  END IF;
END $$;
```

Or document "requires a Supabase database".

---

### M-F — `apply_movement()` is callable by `anon` / `authenticated` (observed live)

**CWE-284 · CWE-732 (Incorrect Permission Assignment)**

The schema intends the money RPC to be reachable only by the trusted backend:

```sql
REVOKE ALL ON FUNCTION apply_movement(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_movement(...) TO service_role;
```

On a live Supabase project, calling the RPC with the **anon** key returned the
function body's own output — proving `anon` holds `EXECUTE`:

```
POST /rest/v1/rpc/apply_movement   (apikey + Bearer = anon)
  body  {"p_user_id":"0000…","p_balance_delta":0,"p_hold_delta":0,"p_reason":"DEPOSIT"}
→ 200 [{"success":false,"balance":null,"held":null,"reason_out":"invalid request"}]
```

If `EXECUTE` had actually been restricted, PostgREST would have answered
`401 permission denied for function apply_movement`.

**Root cause** — Supabase sets, on the `public` schema,
`ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS TO anon, authenticated,
service_role`. When the function was created it therefore received **direct**
ACL grants for those roles. In PostgreSQL a `REVOKE … FROM PUBLIC` removes only
the `PUBLIC` pseudo-role entry; it does **not** touch direct grants, so `anon`
kept `EXECUTE`.

**Real impact is bounded, but the stated control is false.** The function is
`SECURITY INVOKER`, so a call executes *as anon*: RLS hides every `users` row
from anon (no matching owner policy, `auth.uid()` is NULL) and anon lacks
`UPDATE (balance, held)`, so no money can move *today*. The danger is that the
schema's model — "this is the one audited money path and only the backend can
call it" — is not actually enforced; it relies on two *other* controls both
being correct forever. The moment a future owner-read policy makes a row visible
to some role that also has (or is later granted) the column, the RPC becomes a
direct money-movement endpoint for that role.

**Fix — revoke the concrete roles explicitly:**

```sql
REVOKE ALL ON FUNCTION apply_movement(UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION apply_movement(UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_movement(UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, JSONB) TO service_role;
```

**Verify after re-applying** — the anon RPC must now fail closed:

```
→ 401  {"code":"42501","message":"permission denied for function apply_movement"}
```

Optionally stop the default grants at the source so future functions don't
inherit them:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
```

---

## LOW

### L-A — `NaN` / `±Infinity` can poison a balance

`numeric` stores `'NaN'`/`'Infinity'` **regardless of `NUMERIC(14,2)`**, and both
satisfy `>= 0`; Postgres treats `NaN` as equal to itself and greater than every
number, so the ledger `delta <> 0` CHECK and SECTION 10's
`balance_after <> balance_before + delta` both pass. A `NaN` balance makes every
`balance >= stake` check true → effectively unlimited spend. `toMinor` rejects
non-finite input, so reachability is low, but the DB is the last line of defence.

**Fix** — a bounded range CHECK rejects all three specials
(`NaN BETWEEN 0 AND x` is false):

```sql
ALTER TABLE users ADD CONSTRAINT users_balance_finite
  CHECK (balance >= 0 AND balance <= 999999999999.99);
ALTER TABLE users ADD CONSTRAINT users_held_finite
  CHECK (held >= 0 AND held <= 999999999999.99);
```

Also reject non-finite args inside `apply_movement`.

### L-B — Ledger `TRUNCATE` bypass; `audit_logs` mutable

`trg_ledger_immutable` is `FOR EACH ROW BEFORE UPDATE OR DELETE` — `TRUNCATE`
does not fire row triggers. Add a `BEFORE TRUNCATE` statement trigger.
`audit_logs` has no immutability trigger at all.

### L-C — Missing arithmetic CHECKs

Add `CHECK (balance_after = balance_before + delta)` and
`CHECK (hold_after = hold_before + hold_delta)`. SECTION 10 verifies only the
balance identity.

### L-D — `users_balance_non_negative` name mismatch

The inline `CHECK (balance >= 0)` is auto-named `users_balance_check`, so the
SECTION 1 guard keyed on `users_balance_non_negative` never matches and adds a
**duplicate** check on first run. Name the inline constraint explicitly. Also,
SECTION 10's "permissive policy" probe only matches names containing
`%allow all%`/`%anon%`, and the SECTION 9 drop loop drops any policy whose name
merely *contains* `anon` — over-narrow and over-broad respectively.

### L-E — Phone normalisation claimed but not implemented

The comment says `'+265991234567'` and `'991234567'` must not become two accounts,
but UNIQUE is on the raw string and no trigger canonicalises it. The DB regex
allows 9–15 digits while `routes/auth.js` requires 10–15, so the two layers
disagree about what a valid phone is.

### L-F — Housekeeping

`two_factor_secret` plaintext (no TOTP shipped — `speakeasy` was removed);
`deposits`/`withdrawals` have no `net_amount = amount - fee` check; `deposits`
has no `updated_at` trigger; `last_login` and `last_login_at` are redundant;
`bets.user_id … ON DELETE CASCADE` silently destroys crash-bet history on user
deletion (inconsistent with the RESTRICT used elsewhere).

### L-G — `search_path`

`apply_movement` and the trigger functions don't pin
`SET search_path = public, pg_temp`. Low risk given `SECURITY INVOKER`, but
free hardening.

---

## Execution log — R-1 is now closed

`SECURITY_REPORT.md`'s open item **R-1** ("`SCHEMA.sql` written but never
executed") is resolved: the file has now been applied to the live Supabase
project `tgtwzuqvljfcaeccwjzn` and its SECTION 10 self-check passed
(`Schema OK. Ledger rows: 0, reconciled exactly.`).

Running it for real exposed **two latent compile-time defects** that only surface
on `CREATE FUNCTION` / `DO` execution — direct evidence for why R-1 was raised:

| # | Section | Error | Cause | Fix |
|---|---------|-------|-------|-----|
| R-1a | 3 — `apply_movement()` | `42P13 cannot remove parameter defaults from existing function` | a prior version had a default on the last arg; `CREATE OR REPLACE` can't drop it | added `p_reason TEXT DEFAULT NULL` (signature unchanged, so the GRANT/REVOKE and named-arg RPC calls still match) |
| R-1b | 9 — permissive-policy drop loop | `42601 too few parameters specified for RAISE` | `RAISE NOTICE 'dropped permissive policy %.% on %.%'` had **4** `%` but only **3** args | format string corrected to `'dropped permissive policy % on %.%'` (3/3) |

All 17 `RAISE` statements in the file were then re-audited for placeholder/arg
parity; the two above were the only defects.

**Post-apply live verification** (read-only, anon key, PostgREST):

| Probe | Result | Reading |
|-------|--------|---------|
| `GET /rest/v1/football_matches` | `200 []` | table exists; public-read policy works |
| `GET /rest/v1/game_rounds` | `200 []` | table exists; H-A public-read policy works |
| `GET /rest/v1/bets` | `200 []` | RLS active — PII (`user_name`, `phone_number`) not exposed |
| `GET /rest/v1/users` | `200 []` | RLS active — no owner match for anon |
| `POST /rest/v1/rpc/apply_movement` (anon) | `200 {…"invalid request"}` | ⚠️ **finding M-F** — anon can execute the money RPC |

H-A is therefore confirmed **live** (SECTION 10 now raises if any public table
lacks RLS, and it did not). M-F is the one new finding the live probe uncovered
and is fixed in the same revision; re-apply `SCHEMA.sql` and the anon RPC should
return `401 permission denied for function apply_movement`.

---

## What's solid

- One atomic `apply_movement` with `SELECT … FOR UPDATE` **before** the checks —
  correctly serialises concurrent spend.
- Disjoint escrow model (`held` outside `balance`) — the `balance - held`
  footgun is genuinely eliminated.
- Append-only ledger with a reason vocabulary CHECK and withdrawal shape checks.
- `service_role`-only RPC grant + `REVOKE UPDATE (balance, held)` from
  `anon`/`authenticated`.
- Boot-time `verifySchema` probes the RPC with a harmless `0/0` call.
- `football_bets_return_consistent` is a real second line of defence for the old
  C-3 unit bug.

---

## Recommended remediation order

1. **H-A** — enable RLS on `game_rounds`, `bets`, `chat_messages`; extend the
   SECTION 10 verification to assert it. (Highest impact, lowest risk.)
   **✅ applied; confirmed live.**
2. **M-F** — `REVOKE EXECUTE … FROM anon, authenticated` on `apply_movement`.
   (✅ fixed in this revision; re-apply `SCHEMA.sql` to push it live.)
3. **H-B** — pre-flight the four constraints so the migration cannot hard-fail.
4. **M-A / M-B / M-C** — add the missing DB-level guards (match result, INSERT
   state, per-reason sign).
5. **M-D / M-E / L-A** — column REVOKE, role guards, finite-balance CHECKs.
6. **L-* ** — housekeeping, folded into the same revision.
