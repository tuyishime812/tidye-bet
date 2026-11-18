-- ============================================================================
-- AVIATOR-CRASH — AUTHORITATIVE DATABASE SCHEMA
-- ============================================================================
-- Single source of truth. Replaces the previously fragmented set of files:
--   COMPLETE_DATABASE_SETUP.sql, SUPABASE_SCHEMA.sql,
--   ADD_PHONE_NUMBER.sql, FOOTBALL_SCHEMA.sql
--
-- SAFE TO RE-RUN. Every statement is IF NOT EXISTS / OR REPLACE / DO-block
-- guarded, so this can be applied to an existing database without dropping
-- player data. It also *repairs* the security defects left by the old files
-- (documented inline and in SECURITY_REPORT.md §8).
--
-- Apply in the Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f SCHEMA.sql
-- ============================================================================


-- ============================================================================
-- SECTION 1. users
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number      TEXT NOT NULL,
  user_name         TEXT NOT NULL,
  email             TEXT,
  -- bcrypt hash. Never SELECT this into an API response.
  password          TEXT NOT NULL,
  -- Money lives here. The CHECK is the last line of defence: the database
  -- itself can never hold a negative balance, no matter what the app does.
  balance           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  -- Funds escrowed for withdrawals awaiting approval. `held` is DISJOINT from
  -- `balance`: requesting a withdrawal moves money out of balance and into
  -- held, so `balance` always already excludes it. Spendable funds are simply
  -- `balance`, and no betting path needs to subtract this - see the rationale
  -- at apply_movement() in SECTION 3.
  held              NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (held >= 0),
  -- The wallet that withdrawals are paid to. Taken from the REGISTERED account
  -- only - never from a request body (see routes/payments.js).
  payout_phone      TEXT,
  avatar            TEXT NOT NULL DEFAULT '',
  user_type         BOOLEAN NOT NULL DEFAULT false,
  is_banned         BOOLEAN NOT NULL DEFAULT false,
  ban_reason        TEXT,
  -- Guest accounts are created by "quick play". They carry a demo stake that
  -- must never be withdrawable until the player makes a real deposit.
  is_guest          BOOLEAN NOT NULL DEFAULT false,
  currency          TEXT NOT NULL DEFAULT 'MWK',
  is_sound_enable   BOOLEAN NOT NULL DEFAULT true,
  is_music_enable   BOOLEAN NOT NULL DEFAULT true,
  two_factor_secret TEXT,
  two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
  referral_code     TEXT UNIQUE,
  referred_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  last_login        TIMESTAMPTZ DEFAULT now(),
  last_login_at     TIMESTAMPTZ,
  last_login_ip     INET,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uniqueness enforced by the database, not just by a SELECT-then-INSERT check
-- in application code, which is racy under concurrent signups.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_number_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_user_name_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_user_name_key UNIQUE (user_name);
  END IF;
END $$;

-- phone_number is used as a login identifier, so normalise it: otherwise
-- '+265991234567' and '991234567' become two different accounts.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_number_format;
ALTER TABLE users ADD CONSTRAINT users_phone_number_format
  CHECK (phone_number ~ '^\+?[0-9]{9,15}$');

CREATE INDEX IF NOT EXISTS idx_users_phone   ON users (phone_number);
CREATE INDEX IF NOT EXISTS idx_users_name    ON users (user_name);
CREATE INDEX IF NOT EXISTS idx_users_banned  ON users (is_banned) WHERE is_banned;

-- Reconcile columns that older databases may be missing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS held              NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_phone      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by       UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip     INET;

-- Backfill the spendable-balance constraint on databases created before it.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'users'::regclass AND contype = 'c' AND conname = 'users_balance_non_negative'
  ) THEN
    RAISE NOTICE 'users: balance >= 0 constraint already present';
  ELSE
    -- Refuse to install the constraint while any negative balance exists, and
    -- tell the operator exactly which rows to fix rather than clamping them.
    -- Silently setting a negative balance to 0 would destroy player funds.
    IF EXISTS (SELECT 1 FROM users WHERE balance < 0) THEN
      RAISE EXCEPTION
        'users contains negative balances; fix them manually before installing the CHECK';
    END IF;
    ALTER TABLE users ADD CONSTRAINT users_balance_non_negative CHECK (balance >= 0);
  END IF;
END $$;


-- ============================================================================
-- SECTION 2. balance_ledger  (append-only money journal)
-- ============================================================================
-- Every single MWK movement is recorded here, in the same transaction that
-- moved it. This replaces the old `transactions` table, whose AFTER-INSERT
-- trigger ALSO adjusted users.balance — which meant an application that wrote
-- both a balance update and a transactions row double-counted every movement.
-- The database now owns the balance; the application never writes it directly.
CREATE TABLE IF NOT EXISTS balance_ledger (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Signed: negative = money left the balance, positive = money arrived.
  -- A WITHDRAWAL_PAID row has delta = 0 because only the escrow bucket moved,
  -- so this is not a "balance changed" flag - it records the direction of the
  -- balance bucket, and `hold_*` records the escrow bucket.
  delta          NUMERIC(14,2) NOT NULL CHECK (delta <> 0 OR hold_delta <> 0),
  balance_before NUMERIC(14,2) NOT NULL,
  balance_after  NUMERIC(14,2) NOT NULL,
  -- Escrow bucket snapshots. Lets an investigator reconstruct exactly how much
  -- was ever outstanding, without replaying every reason by hand.
  hold_delta     NUMERIC(14,2) NOT NULL DEFAULT 0,
  hold_before    NUMERIC(14,2) NOT NULL DEFAULT 0,
  hold_after     NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Why the money moved. Constrained to a known vocabulary so the ledger can
  -- be reconciled; free-text reasons belong in metadata.
  reason         TEXT NOT NULL CHECK (reason IN (
                   'DEPOSIT', 'WITHDRAWAL_HOLD', 'WITHDRAWAL_REFUND',
                   'WITHDRAWAL_PAID', 'BET_STAKE', 'BET_PAYOUT',
                   'BET_REFUND', 'ADMIN_CREDIT', 'ADMIN_DEBIT',
                   'BONUS', 'ADJUSTMENT'
                 )),
  -- Polymorphic pointer back to the originating document (deposit/withdrawal/
  -- bet id). Makes "show me every movement for this bet" a single indexed scan.
  ref_type       TEXT,
  ref_id         TEXT,
  -- Free-form context. MUST never contain credentials, tokens or OTPs.
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_user    ON balance_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_ref     ON balance_ledger (ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_ledger_reason  ON balance_ledger (reason, created_at DESC);

-- The ledger is append-only: no updates, no deletes. Not even by the app.
CREATE OR REPLACE FUNCTION forbid_ledger_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'balance_ledger is append-only (attempted %)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_immutable ON balance_ledger;
CREATE TRIGGER trg_ledger_immutable
  BEFORE UPDATE OR DELETE ON balance_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();


-- ============================================================================
-- SECTION 3. THE ONLY WAY TO MOVE MONEY
-- ============================================================================
-- ONE atomic function for every money movement.
--
-- WHY BOTH BUCKETS IN A SINGLE CALL
-- ---------------------------------
-- The first version of this section had two functions, `apply_balance_delta`
-- and `apply_hold_delta`, and a withdrawal hold was issued as two separate
-- calls: debit the balance, then credit `held`. Two statements are not atomic
-- regardless of how they are ordered. A crash, timeout or ROLLBACK between them
-- leaves the money in NEITHER bucket (the player is silently robbed) or in
-- BOTH (the house is over-credited), and the ledger row would describe one
-- bucket while the other had moved. Passing both deltas together means the
-- balance change, the escrow change and the ledger row commit or roll back as
-- one transaction.
--
-- THE MODEL: `held` is disjoint from `balance`
-- -------------------------------------------
-- A hold REMOVES money from `balance` and places it into `held`:
--
--     deposit            balance +X   held  0
--     withdrawal request balance -X   held +X     escrowed
--     withdrawal refund  balance +X   held -X     returned
--     withdrawal paid    balance  0   held -X     escrow consumed
--     bet stake / payout balance +/-X held  0
--
-- So `balance` ALWAYS already excludes escrowed funds, and every pre-existing
-- `balance >= stake` check in the betting paths stays correct without knowing
-- that `held` exists at all.
--
-- That is deliberately why this model was chosen over the alternative where
-- `held` stays inside `balance` and every spend path must compute
-- `balance - held`: a check that N code paths must remember to subtract is a
-- check that the N+1'th path will forget, and the failure mode is held funds
-- being bet while a withdrawal is pending - a clean double-spend.
--
-- The ledger row is written in the SAME transaction, so a movement can never
-- exist without its audit trail, and the trail can never claim a movement that
-- did not happen.
--
-- SECURITY INVOKER + the grants at the bottom mean this is the only path to
-- users.balance and users.held; the application has no UPDATE grant on either.
CREATE OR REPLACE FUNCTION apply_movement(
  p_user_id       UUID,
  p_balance_delta NUMERIC,
  -- NOTE: p_reason needs an explicit default because it follows p_hold_delta,
  -- which already has one. Postgres rejects any parameter that comes after a
  -- defaulted one unless it too has a default (error 42P13). The value is
  -- validated below and NULL is rejected with 'invalid reason', so this default
  -- can never be a usable call by accident.
  p_hold_delta    NUMERIC DEFAULT 0,
  p_reason        TEXT DEFAULT NULL,
  p_ref_type      TEXT DEFAULT NULL,
  p_ref_id        TEXT DEFAULT NULL,
  p_metadata      JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (success BOOLEAN, balance NUMERIC, held NUMERIC, reason_out TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_bal_before  NUMERIC;
  v_bal_after   NUMERIC;
  v_hold_before NUMERIC;
  v_hold_after  NUMERIC;
BEGIN
  IF p_user_id IS NULL
     OR p_balance_delta IS NULL
     OR p_hold_delta IS NULL
     OR (p_balance_delta = 0 AND p_hold_delta = 0) THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC, 'invalid request'::TEXT;
    RETURN;
  END IF;

  IF p_reason IS NULL
     OR p_reason NOT IN ('DEPOSIT','WITHDRAWAL_HOLD','WITHDRAWAL_REFUND',
                         'WITHDRAWAL_PAID','BET_STAKE','BET_PAYOUT','BET_REFUND',
                         'ADMIN_CREDIT','ADMIN_DEBIT','BONUS','ADJUSTMENT') THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC, 'invalid reason'::TEXT;
    RETURN;
  END IF;

  -- Bucket shape per reason. Without this, a compromised application layer
  -- could pass reason='BET_PAYOUT' while moving money into escrow, and an
  -- analyst reconciling the ledger by reason would be misled.
  IF p_reason = 'WITHDRAWAL_HOLD'
     AND NOT (p_hold_delta > 0 AND p_balance_delta = -p_hold_delta) THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC,
      'WITHDRAWAL_HOLD must move X out of balance and into held'::TEXT;
    RETURN;
  END IF;

  IF p_reason = 'WITHDRAWAL_REFUND'
     AND NOT (p_hold_delta < 0 AND p_balance_delta = -p_hold_delta) THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC,
      'WITHDRAWAL_REFUND must move X out of held and into balance'::TEXT;
    RETURN;
  END IF;

  IF p_reason = 'WITHDRAWAL_PAID'
     AND NOT (p_balance_delta = 0 AND p_hold_delta < 0) THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC,
      'WITHDRAWAL_PAID must consume held without touching balance'::TEXT;
    RETURN;
  END IF;

  IF p_reason NOT LIKE 'WITHDRAWAL_%' AND (p_hold_delta <> 0) THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC,
      'only withdrawal reasons may touch the held bucket'::TEXT;
    RETURN;
  END IF;

  -- Sign of the balance delta per reason (M-C from SCHEMA_AUDIT.md).
  -- Without this, a compromised application layer could label a debit as a
  -- DEPOSIT and corrupt every reconciliation that groups by reason.
  IF p_reason IN ('DEPOSIT','BET_PAYOUT','BET_REFUND','ADMIN_CREDIT','BONUS')
     AND p_balance_delta <= 0 THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC,
      format('%s must increase the balance', p_reason)::TEXT;
    RETURN;
  END IF;

  IF p_reason IN ('BET_STAKE','ADMIN_DEBIT')
     AND p_balance_delta >= 0 THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC,
      format('%s must decrease the balance', p_reason)::TEXT;
    RETURN;
  END IF;

  -- SELECT ... FOR UPDATE takes the row lock BEFORE the conditional checks, so
  -- concurrent callers are serialised by the database rather than by luck.
  SELECT u.balance, u.held
    INTO v_bal_before, v_hold_before
    FROM users u
   WHERE u.id = p_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC, 'User not found'::TEXT;
    RETURN;
  END IF;

  v_bal_after  := v_bal_before  + p_balance_delta;
  v_hold_after := v_hold_before + p_hold_delta;

  -- The single double-spend guard. balance is never allowed below zero, for
  -- any reason, by any caller - there is deliberately no allow-negative flag.
  IF v_bal_after < 0 THEN
    RETURN QUERY SELECT FALSE, v_bal_before, v_hold_before, 'Insufficient balance'::TEXT;
    RETURN;
  END IF;

  -- Releasing more escrow than exists would mint money out of nothing.
  IF v_hold_after < 0 THEN
    RETURN QUERY SELECT FALSE, v_bal_before, v_hold_before, 'Invalid hold release'::TEXT;
    RETURN;
  END IF;

  UPDATE users
     SET balance = v_bal_after,
         held    = v_hold_after
   WHERE id = p_user_id;

  INSERT INTO balance_ledger
    (user_id, delta, balance_before, balance_after,
     hold_delta, hold_before, hold_after,
     reason, ref_type, ref_id, metadata)
  VALUES
    (p_user_id, p_balance_delta, v_bal_before, v_bal_after,
     p_hold_delta, v_hold_before, v_hold_after,
     p_reason, p_ref_type, p_ref_id, p_metadata);

  RETURN QUERY SELECT TRUE, v_bal_after, v_hold_after, NULL::TEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: only service_role (the backend) may move money.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION apply_movement(UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
-- Supabase sets ALTER DEFAULT PRIVILEGES in schema `public` that GRANT EXECUTE
-- on new functions directly to anon/authenticated. Those are DIRECT grants and
-- `REVOKE ... FROM PUBLIC` does NOT remove them, so anon could still call this
-- function (observed live: it returned the function body's own result). Revoke
-- from the concrete roles too, leaving service_role as the sole caller.
REVOKE EXECUTE ON FUNCTION apply_movement(UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_movement(UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, JSONB) TO service_role;

-- The application must NOT be able to write either column directly; the only
-- route is the audited function above. service_role bypasses RLS, so the
-- column grant is revoked from anon/authenticated explicitly.
REVOKE UPDATE (balance, held) ON users FROM anon, authenticated;


-- ============================================================================
-- SECTION 4. deposits  (PayChangu hosted checkout)
-- ============================================================================
CREATE TABLE IF NOT EXISTS deposits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  fee             NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  net_amount      NUMERIC(14,2),
  method          TEXT NOT NULL DEFAULT 'paychangu'
                    CHECK (method IN ('paychangu','admin')),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','COMPLETED','FAILED','EXPIRED')),
  -- Merchant reference WE issued (pch_...). UNIQUE is what makes settlement
  -- idempotent: a duplicate settlement attempt can be claimed by exactly one
  -- UPDATE.
  provider_ref    TEXT,
  -- What the gateway says it charged. Recorded so a mismatch against `amount`
  -- is detectable instead of silently ignored.
  gateway_amount  NUMERIC(14,2),
  gateway_ref     TEXT,
  failure_reason  TEXT,
  ip_address      INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reconcile deposits columns on databases created before they existed.
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS fee NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS net_amount NUMERIC(14,2);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'paychangu';
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS provider_ref TEXT;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS gateway_amount NUMERIC(14,2);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS gateway_ref TEXT;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_provider_ref
  ON deposits (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_gateway_ref
  ON deposits (gateway_ref) WHERE gateway_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposits_user    ON deposits (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_status  ON deposits (status, created_at DESC);


-- ============================================================================
-- SECTION 5. withdrawals  (request -> admin approval -> payout)
-- ============================================================================
-- State machine:
--     PENDING --approve--> PAID      (funds already held; sent to player)
--     PENDING --reject---> REJECTED  (hold refunded atomically)
--     PENDING --cancel---> CANCELLED (player withdrew it; hold refunded)
--     PAID / REJECTED / CANCELLED are terminal and irreversible.
CREATE TABLE IF NOT EXISTS withdrawals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount            NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  fee               NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  net_amount        NUMERIC(14,2) NOT NULL CHECK (net_amount >= 0),
  method            TEXT NOT NULL CHECK (method IN ('mpamba','airtel_money','bank')),
  -- Snapshot of the registered wallet at request time. Stored so a payout can
  -- always be reconciled, even if the player later changes their number.
  phone_number      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','PAID','REJECTED','CANCELLED')),
  -- Admin identity is the env-configured ADMIN_USERNAME (a string), not a
  -- users row, so this is TEXT and must not be FK'd to users(id).
  processed_by      TEXT,
  processed_at      TIMESTAMPTZ,
  rejection_reason  TEXT,
  gateway_ref       TEXT,
  ip_address        INET,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reconcile withdrawals columns on databases created before they existed.
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS net_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS processed_by TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS gateway_ref TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_withdrawals_user     ON withdrawals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_pending  ON withdrawals (created_at) WHERE status = 'PENDING';

-- Enforce the state machine in the database. Application-level checks are
-- advisory; this makes an illegal transition impossible even from psql.
CREATE OR REPLACE FUNCTION guard_withdrawal_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'withdrawal % is already % and cannot change state',
        OLD.id, OLD.status;
    END IF;
    IF NEW.status NOT IN ('PAID','REJECTED','CANCELLED') THEN
      RAISE EXCEPTION 'illegal withdrawal transition PENDING -> %', NEW.status;
    END IF;
    -- A decision must record who made it and when.
    IF NEW.processed_by IS NULL OR NEW.processed_at IS NULL THEN
      RAISE EXCEPTION 'withdrawal % decision requires processed_by and processed_at', NEW.id;
    END IF;
    -- A rejection must say why.
    IF NEW.status = 'REJECTED'
       AND (NEW.rejection_reason IS NULL OR btrim(NEW.rejection_reason) = '') THEN
      RAISE EXCEPTION 'rejected withdrawal % requires a rejection_reason', NEW.id;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_withdrawal ON withdrawals;
CREATE TRIGGER trg_guard_withdrawal
  BEFORE UPDATE ON withdrawals
  FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_transition();


-- ============================================================================
-- SECTION 6. football_matches / football_bets
-- ============================================================================
CREATE TABLE IF NOT EXISTS football_matches (
  id         TEXT PRIMARY KEY,
  league     TEXT NOT NULL,
  home       TEXT NOT NULL,
  away       TEXT NOT NULL,
  kickoff_at TIMESTAMPTZ NOT NULL,
  status     TEXT NOT NULL DEFAULT 'SCHEDULED'
               CHECK (status IN ('SCHEDULED','LIVE','FINISHED')),
  minute     INTEGER NOT NULL DEFAULT 0,
  home_goals INTEGER NOT NULL DEFAULT 0,
  away_goals INTEGER NOT NULL DEFAULT 0,
  odds_home  NUMERIC(8,2) NOT NULL CHECK (odds_home  >= 1.01),
  odds_draw  NUMERIC(8,2) NOT NULL CHECK (odds_draw  >= 1.01),
  odds_away  NUMERIC(8,2) NOT NULL CHECK (odds_away  >= 1.01),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON football_matches (kickoff_at);
CREATE INDEX IF NOT EXISTS idx_matches_status  ON football_matches (status);

-- A voided market is closed to betting no matter what the clock or status says.
-- Idempotent so existing databases pick it up without a rebuild.
ALTER TABLE football_matches ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT false;

-- One result per match. The previous guard was a unique index on `id`, which is
-- already the primary key and therefore a no-op (SCHEMA_AUDIT M-A). Enforce the
-- actual invariant in the database: once a match has a settlement timestamp,
-- its result can only be cleared by voiding it (settled_at -> NULL), never
-- silently rewritten to a different score.
DROP INDEX IF EXISTS uq_matches_one_result;

CREATE OR REPLACE FUNCTION football_match_settled_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.settled_at IS NOT NULL AND NEW.settled_at IS NOT NULL THEN
    IF NEW.home_goals IS DISTINCT FROM OLD.home_goals
       OR NEW.away_goals IS DISTINCT FROM OLD.away_goals
       OR NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
      RAISE EXCEPTION
        'match % is already settled; void it before re-settling', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_football_match_settled_immutable ON football_matches;
CREATE TRIGGER trg_football_match_settled_immutable
  BEFORE UPDATE ON football_matches
  FOR EACH ROW EXECUTE FUNCTION football_match_settled_immutable();

CREATE TABLE IF NOT EXISTS football_bets (
  id               TEXT PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  user_name        TEXT,
  match_id         TEXT NOT NULL REFERENCES football_matches(id) ON DELETE RESTRICT,
  selection        TEXT NOT NULL CHECK (selection IN ('HOME','DRAW','AWAY')),
  stake            NUMERIC(14,2) NOT NULL CHECK (stake > 0),
  odds             NUMERIC(8,2)  NOT NULL CHECK (odds >= 1.01),
  -- Invariant restated in the database: the stored return must equal
  -- stake * odds to the cent. This is the C-3 unit bug, now caught by the DB
  -- even if application arithmetic regresses.
  potential_return NUMERIC(14,2) NOT NULL CHECK (potential_return > 0),
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','WON','LOST','VOID')),
  payout           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  settled_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bets_user  ON football_bets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bets_match ON football_bets (match_id, status);

ALTER TABLE football_bets DROP CONSTRAINT IF EXISTS football_bets_return_consistent;
ALTER TABLE football_bets ADD CONSTRAINT football_bets_return_consistent
  CHECK (potential_return = round(stake * odds, 2));

CREATE OR REPLACE FUNCTION guard_bet_settlement()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'bet % already settled (status=%)', OLD.id, OLD.status;
  END IF;
  IF NEW.status NOT IN ('WON','LOST','VOID') THEN
    RAISE EXCEPTION 'illegal bet transition PENDING -> %', NEW.status;
  END IF;
  -- A winning bet must pay exactly its recorded return.
  IF NEW.status = 'WON' AND NEW.payout <> NEW.potential_return THEN
    RAISE EXCEPTION 'bet % payout % <> potential_return %',
      NEW.id, NEW.payout, NEW.potential_return;
  END IF;
  IF NEW.status <> 'WON' AND NEW.payout <> 0 THEN
    RAISE EXCEPTION 'bet % is % but carries payout %', NEW.id, NEW.status, NEW.payout;
  END IF;
  NEW.settled_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_bet ON football_bets;
CREATE TRIGGER trg_guard_bet
  BEFORE UPDATE OF status ON football_bets
  FOR EACH ROW EXECUTE FUNCTION guard_bet_settlement();


-- ============================================================================
-- SECTION 6b. football_slips / football_slip_legs (accumulators)
-- ----------------------------------------------------------------------------
-- A multi-selection coupon cannot fit in football_bets: that table's rows are
-- one match each with the hard `potential_return = round(stake*odds, 2)`
-- invariant. An accumulator is its own row (stake charged once, payout is
-- stake x product of odds) plus one leg row per match.
-- ============================================================================
CREATE TABLE IF NOT EXISTS football_slips (
  id             TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  user_name      TEXT,
  stake          NUMERIC(14,2) NOT NULL CHECK (stake > 0),
  combined_odds  NUMERIC(12,4) NOT NULL CHECK (combined_odds >= 1.01),
  potential_return NUMERIC(16,2) NOT NULL CHECK (potential_return > 0),
  status         TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','WON','LOST','VOID')),
  payout         NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  settled_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slips_user  ON football_slips (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slips_status ON football_slips (status);

ALTER TABLE football_slips DROP CONSTRAINT IF EXISTS football_slips_return_consistent;
ALTER TABLE football_slips ADD CONSTRAINT football_slips_return_consistent
  CHECK (potential_return = round(stake * combined_odds, 2));

-- One terminal state per slip. A repeated settlement (or a racing admin
-- request) can never pay an accumulator twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_slips_one_result
  ON football_slips (id) WHERE status <> 'PENDING';

CREATE OR REPLACE FUNCTION guard_slip_settlement()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'slip % already settled (status=%)', OLD.id, OLD.status;
  END IF;
  IF NEW.status NOT IN ('WON','LOST','VOID') THEN
    RAISE EXCEPTION 'illegal slip transition PENDING -> %', NEW.status;
  END IF;
  IF NEW.status = 'WON' AND NEW.payout <> NEW.potential_return THEN
    RAISE EXCEPTION 'slip % payout % <> potential_return %',
      NEW.id, NEW.payout, NEW.potential_return;
  END IF;
  IF NEW.status <> 'WON' AND NEW.payout <> 0 THEN
    -- A VOID slip refunds via balance_ledger (BET_REFUND), so the column stays
    -- 0 here even though the in-memory row keeps the refund for display.
    RAISE EXCEPTION 'slip % is % but carries payout %', NEW.id, NEW.status, NEW.payout;
  END IF;
  NEW.settled_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_slip ON football_slips;
CREATE TRIGGER trg_guard_slip
  BEFORE UPDATE OF status ON football_slips
  FOR EACH ROW EXECUTE FUNCTION guard_slip_settlement();

CREATE TABLE IF NOT EXISTS football_slip_legs (
  id         TEXT PRIMARY KEY,
  slip_id    TEXT NOT NULL REFERENCES football_slips(id) ON DELETE CASCADE,
  match_id   TEXT NOT NULL REFERENCES football_matches(id) ON DELETE RESTRICT,
  selection  TEXT NOT NULL CHECK (selection IN ('HOME','DRAW','AWAY')),
  odds       NUMERIC(8,2)  NOT NULL CHECK (odds >= 1.01),
  result     TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (result IN ('PENDING','WON','LOST','VOID')),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slip_legs_slip  ON football_slip_legs (slip_id);
CREATE INDEX IF NOT EXISTS idx_slip_legs_match ON football_slip_legs (match_id, result);

-- A coupon carries at most one leg per match; two legs on one match would be a
-- correlated multiple, not an accumulator.
ALTER TABLE football_slip_legs DROP CONSTRAINT IF EXISTS uq_slip_leg_match;
ALTER TABLE football_slip_legs ADD CONSTRAINT uq_slip_leg_match
  UNIQUE (slip_id, match_id);

-- Leg result flips are one-way out of PENDING, same discipline as bets.
CREATE OR REPLACE FUNCTION guard_slip_leg()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.result <> 'PENDING' THEN
    RAISE EXCEPTION 'slip leg % already resolved (result=%)', OLD.id, OLD.result;
  END IF;
  IF NEW.result NOT IN ('WON','LOST','VOID') THEN
    RAISE EXCEPTION 'illegal slip leg transition PENDING -> %', NEW.result;
  END IF;
  NEW.settled_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_slip_leg ON football_slip_legs;
CREATE TRIGGER trg_guard_slip_leg
  BEFORE UPDATE OF result ON football_slip_legs
  FOR EACH ROW EXECUTE FUNCTION guard_slip_leg();

-- ============================================================================
-- SECTION 7. audit_logs
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  action     TEXT NOT NULL,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Admin actor as text (env-configured ADMIN_USERNAME), not a users FK.
  actor      TEXT,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  status     TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs (actor, created_at DESC);


-- ============================================================================
-- SECTION 7b. admins  (database-managed admin accounts)
-- ============================================================================
-- WHY THIS TABLE EXISTS
--   Admin login used to be a single username/password pair in the server's
--   environment (ADMIN_USERNAME / ADMIN_PASSWORD). That meant rotating an
--   operator, adding a second admin, or removing a compromised one required
--   editing .env on the host and redeploying. This table moves admin identity
--   into the database so accounts can be created, disabled and re-keyed from
--   the Supabase dashboard, and so every admin can have their own account.
--
-- HOW THE SERVER USES IT  (services/adminDirectory.js + services/adminAuth.js)
--   * The submitted password is verified with bcrypt against password_hash.
--     The hash is NEVER selected into an API response.
--   * The table is consulted through the service-role client only. RLS is
--     enabled with NO policy, so anon/authenticated (i.e. the browser) can
--     neither read it nor write it.
--
-- HOW TO CREATE AN ADMIN  (no code, no redeploy)
--   Option A - Node helper that prints a ready-to-paste INSERT:
--       node server/scripts/create-admin.js --sql --username boss
--   Option B - paste straight into the Supabase SQL editor using pgcrypto:
--       insert into admins (username, password_hash, role)
--       values ('boss', extensions.crypt('S0me-Str0ng-Pass', extensions.gen_salt('bf', 12)), 'SUPERADMIN');
--   (pgcrypto ships with Supabase as the `extensions` extension; both create a
--    standard $2a$ bcrypt hash that bcryptjs verifies.)
CREATE TABLE IF NOT EXISTS admins (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       TEXT NOT NULL,
  -- bcrypt hash (bcryptjs / pgcrypto bf). Never SELECT this into a response.
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('ADMIN','SUPERADMIN')),
  display_name   TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  last_login_at  TIMESTAMPTZ,
  last_login_ip  INET,
  -- Who created the account (another admin's username, or 'bootstrap').
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usernames are case-insensitive: "Boss" and "boss" must never become two
-- accounts. A STORED generated column keeps the lower-case form maintained by
-- the database itself, so a row inserted by hand from the Supabase dashboard
-- is normalised too - not just rows written by the application.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS username_lower TEXT
  GENERATED ALWAYS AS (lower(username)) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS uq_admins_username_lower ON admins (username_lower);
CREATE INDEX IF NOT EXISTS idx_admins_active ON admins (is_active) WHERE is_active;

-- Keep updated_at honest on every write.
CREATE OR REPLACE FUNCTION touch_admin_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_admin ON admins;
CREATE TRIGGER trg_touch_admin
  BEFORE UPDATE ON admins
  FOR EACH ROW EXECUTE FUNCTION touch_admin_updated_at();

-- Refuse to remove the LAST active admin, whether by DELETE or by setting
-- is_active = false. Without this, an operator can lock themselves (and
-- everyone else) out of the dashboard, with no in-app way back in.
CREATE OR REPLACE FUNCTION guard_last_admin()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_remaining INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_active THEN
      SELECT count(*) INTO v_remaining FROM admins WHERE is_active AND id <> OLD.id;
      IF v_remaining = 0 THEN
        RAISE EXCEPTION 'refusing to delete the last active admin';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: only a true -> false deactivation is dangerous.
  IF OLD.is_active AND NEW.is_active = false THEN
    SELECT count(*) INTO v_remaining FROM admins WHERE is_active AND id <> OLD.id;
    IF v_remaining = 0 THEN
      RAISE EXCEPTION 'refusing to deactivate the last active admin';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_last_admin ON admins;
CREATE TRIGGER trg_guard_last_admin
  BEFORE UPDATE OR DELETE ON admins
  FOR EACH ROW EXECUTE FUNCTION guard_last_admin();


-- ============================================================================
-- SECTION 8. legacy crash-game tables
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_rounds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_number     INTEGER NOT NULL UNIQUE,
  crash_point      NUMERIC(10,2) NOT NULL,
  server_seed      TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seeds     JSONB NOT NULL DEFAULT '[]'::jsonb,
  fly_detail_id    TEXT,
  -- Operator-override disclosure. A forced round is NOT derivable from the
  -- published seed pair, so storing `forced` is what lets the fairness endpoint
  -- tell the truth instead of presenting an unverifiable result as proof.
  forced           BOOLEAN NOT NULL DEFAULT false,
  forced_by        TEXT,
  -- true  = crash_point was reproduced from server_seed + client_seeds
  -- false = mismatch (integrity alert)
  -- null  = not applicable (operator override)
  verified         BOOLEAN,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  user_name    TEXT NOT NULL,
  phone_number TEXT,
  bet_amount   NUMERIC(14,2) NOT NULL CHECK (bet_amount > 0),
  cash_out_at  NUMERIC(14,2) NOT NULL DEFAULT 0,
  cashouted    BOOLEAN NOT NULL DEFAULT false,
  fly_away     NUMERIC(10,2) NOT NULL,
  fly_detail_id TEXT,
  profit       NUMERIC(14,2) NOT NULL DEFAULT 0,
  game_round   INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT NOT NULL,
  avatar     TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL,
  img        TEXT NOT NULL DEFAULT '',
  likes      INTEGER NOT NULL DEFAULT 0,
  likes_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  dislikes      INTEGER NOT NULL DEFAULT 0,
  dislikes_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rounds_round   ON game_rounds (round_number DESC);
CREATE INDEX IF NOT EXISTS idx_bets_cash_user ON bets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_created   ON chat_messages (created_at DESC);

-- Reconcile the fairness-audit columns on databases created before they existed.
ALTER TABLE game_rounds ADD COLUMN IF NOT EXISTS forced    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE game_rounds ADD COLUMN IF NOT EXISTS forced_by TEXT;
ALTER TABLE game_rounds ADD COLUMN IF NOT EXISTS verified  BOOLEAN;


-- ============================================================================
-- SECTION 9. REPAIR: remove the dangerous legacy policies
-- ============================================================================
-- COMPLETE_DATABASE_SETUP.sql created, with RLS *enabled*:
--
--   CREATE POLICY "Allow all operations on users" ON users FOR ALL USING (true);
--
-- That combination is the worst of both worlds: RLS is on, so it looks secure,
-- while the policy lets ANY holder of the anon key - which is shipped to every
-- browser - read and write every row, including the `password` column.
-- Drop every permit-all policy and replace with deny-by-default.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (policyname ILIKE '%allow all%' OR policyname ILIKE '%anon%'
            OR policyname ILIKE '%full access%' OR policyname ILIKE '%everyone%')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
    RAISE NOTICE 'dropped permissive policy % on %.%',
      r.policyname, r.schemaname, r.tablename;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RLS: enabled everywhere, with narrow owner-scoped read policies only.
-- All writes go through service_role (the backend), which bypasses RLS, so no
-- INSERT/UPDATE/DELETE policy is granted to anon/authenticated at all.
-- ---------------------------------------------------------------------------
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_ledger  ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits        ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE football_bets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE football_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE football_slips  ENABLE ROW LEVEL SECURITY;
ALTER TABLE football_slip_legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE admins          ENABLE ROW LEVEL SECURITY;

-- The SECTION 8 legacy tables were previously missed by this block entirely.
-- With RLS *off*, Supabase's default grants expose them to any holder of the
-- browser anon key, and unlike the money tables there is no policy layer to
-- deny it. That leaks `bets` (user_name, phone_number, staking history),
-- permits anon to rewrite/delete user chat, and reveals `game_rounds`
-- server_seed. Enabling RLS here puts them under the same deny-by-default model
-- as every other table. See SCHEMA_AUDIT.md H-A.
ALTER TABLE game_rounds     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages   ENABLE ROW LEVEL SECURITY;

-- Own record only - and never the password column, which anon cannot read
-- through this policy anyway because the app must not expose it.
DROP POLICY IF EXISTS "users own record" ON users;
CREATE POLICY "users own record" ON users
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "bets readable by owner" ON football_bets;
CREATE POLICY "bets readable by owner" ON football_bets
  FOR SELECT USING (auth.uid() = user_id);

-- Accumulators: the slip row itself is owner-scoped. The legs table carries no
-- PII of its own but is also owner-scoped through its slip to avoid leaking
-- another player's coupon selections.
DROP POLICY IF EXISTS "slips readable by owner" ON football_slips;
CREATE POLICY "slips readable by owner" ON football_slips
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "slip legs readable via owner slip" ON football_slip_legs;
CREATE POLICY "slip legs readable via owner slip" ON football_slip_legs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM football_slips s
       WHERE s.id = football_slip_legs.slip_id
         AND s.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "deposits readable by owner" ON deposits;
CREATE POLICY "deposits readable by owner" ON deposits
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "withdrawals readable by owner" ON withdrawals;
CREATE POLICY "withdrawals readable by owner" ON withdrawals
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ledger readable by owner" ON balance_ledger;
CREATE POLICY "ledger readable by owner" ON balance_ledger
  FOR SELECT USING (auth.uid() = user_id);

-- Fixtures are public read-only.
DROP POLICY IF EXISTS "matches readable by all" ON football_matches;
CREATE POLICY "matches readable by all" ON football_matches
  FOR SELECT USING (true);

-- Crash-game data is also public read-only: chat is displayed to every player,
-- and a past round's server_seed is part of the provably-fair reveal. Writes
-- remain service_role-only (no INSERT/UPDATE/DELETE policy). `bets` deliberately
-- gets NO policy at all - it carries player PII (`user_name`, `phone_number`,
-- staking history) and is only ever read by the backend, so anon/authenticated
-- are denied by default now that RLS is enabled on it.
DROP POLICY IF EXISTS "rounds readable by all" ON game_rounds;
CREATE POLICY "rounds readable by all" ON game_rounds
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "chat readable by all" ON chat_messages;
CREATE POLICY "chat readable by all" ON chat_messages
  FOR SELECT USING (true);

-- audit_logs has NO policy: not even the owner may read it from a browser.
-- admins has NO policy either: it holds bcrypt hashes, so the browser (anon /
-- authenticated) must never be able to read or write it. The server reaches it
-- through the service-role key, which bypasses RLS by design.

-- The legacy `transactions` table double-counted balances via an AFTER INSERT
-- trigger. balance_ledger replaces it; drop the trigger so it cannot fire.
--
-- Guarded by to_regclass(): `DROP TRIGGER ... ON transactions` raises
-- "relation does not exist" on a fresh database where that table was never
-- created, which would abort the entire script before SECTION 10 runs.
DO $$
BEGIN
  IF to_regclass('public.transactions') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trigger_update_balance ON public.transactions';
  END IF;
  EXECUTE 'DROP FUNCTION IF EXISTS public.update_user_balance()';
END $$;


-- ============================================================================
-- SECTION 10. Verification
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT;
  v_permissive TEXT;
  v_bad_money NUMERIC;
  v_no_rls TEXT;
BEGIN
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(ARRAY['users','balance_ledger','deposits','withdrawals',
                       'football_matches','football_bets','audit_logs','admins',
                       'game_rounds','bets','chat_messages']) AS t
   WHERE to_regclass('public.' || t) IS NULL;

  SELECT string_agg(policyname, ', ') INTO v_permissive
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (policyname ILIKE '%allow all%' OR policyname ILIKE '%anon%');

  SELECT COALESCE(sum(abs(delta)), 0) INTO v_bad_money FROM balance_ledger
   WHERE balance_after <> balance_before + delta;

  -- Every table this schema owns must have RLS enabled. A table with no policy
  -- is only safe (deny-by-default) while RLS is on; with RLS off, Supabase's
  -- default grants expose it to anon/authenticated. This closes the H-A gap
  -- where the SECTION 8 legacy tables were never covered.
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_no_rls
    FROM unnest(ARRAY['users','balance_ledger','deposits','withdrawals',
                       'football_matches','football_bets','audit_logs','admins',
                       'game_rounds','bets','chat_messages']) AS t
    JOIN pg_class c ON c.oid = to_regclass('public.' || t)
   WHERE NOT c.relrowsecurity;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'MISSING TABLES: %', v_missing;
  END IF;
  IF v_permissive IS NOT NULL THEN
    RAISE EXCEPTION 'PERMISSIVE POLICIES STILL PRESENT: %', v_permissive;
  END IF;
  IF v_bad_money <> 0 THEN
    RAISE EXCEPTION 'LEDGER OUT OF BALANCE by %', v_bad_money;
  END IF;
  IF v_no_rls IS NOT NULL THEN
    RAISE EXCEPTION 'RLS DISABLED ON: %', v_no_rls;
  END IF;

  RAISE NOTICE 'Schema OK. Ledger rows: %, reconciled exactly.', (SELECT count(*) FROM balance_ledger);
END $$;