-- ============================================================================
-- AVIATOR-CRASH — ADMIN ACCOUNTS MIGRATION  (idempotent, safe to re-run)
-- ============================================================================
-- Extracted from SCHEMA.sql SECTION 7b so you can add database-backed admin
-- accounts WITHOUT re-running the whole schema.
--
-- Paste this whole file into the Supabase SQL editor and run it, then create
-- your first admin (see the bottom of this file).
--
-- Running the full server/SCHEMA.sql achieves the same thing and is also safe.
-- ============================================================================

-- ============================================================================
-- admins  (database-managed admin accounts)
-- ============================================================================
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
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness, maintained by the database itself.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS username_lower TEXT
  GENERATED ALWAYS AS (lower(username)) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS uq_admins_username_lower ON admins (username_lower);
CREATE INDEX IF NOT EXISTS idx_admins_active ON admins (is_active) WHERE is_active;

-- Keep updated_at honest.
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

-- Refuse to remove the LAST active admin (delete or deactivate).
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

-- ---------------------------------------------------------------------------
-- RLS: enabled, with NO policy. The browser anon/authenticated keys therefore
-- can neither read nor write this table; only the server's service-role key
-- (which bypasses RLS by design) can.
-- ---------------------------------------------------------------------------
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- CREATE YOUR FIRST ADMIN  (run AFTER the statements above)
-- ============================================================================
-- Option A — pgcrypto (bundled with Supabase), hashes for you:
--
--   insert into admins (username, password_hash, role)
--   values ('boss', extensions.crypt('S0me-Str0ng-Pass', extensions.gen_salt('bf', 12)), 'SUPERADMIN');
--
-- Option B — paste the output of:
--   cd server && node scripts/create-admin.js --sql --username boss
--
-- Re-running either for the same username resets that admin's password.
