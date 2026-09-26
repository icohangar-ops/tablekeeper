-- ═══════════════════════════════════════════════════════════════════════════
-- Tablekeeper schema — Postgres (runs on embedded PGlite AND real Postgres).
--
-- The single most important statement in this file is the EXCLUDE constraint
-- at the bottom: it makes double-booking physically impossible at the
-- storage layer. See docs/BUILD_PLAN.md §2.3.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS restaurants (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  cuisine    TEXT NOT NULL,
  timezone   TEXT NOT NULL,                -- IANA, e.g. "America/New_York"
  address    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,             -- "T1", "Patio 3"
  capacity      INT  NOT NULL CHECK (capacity >= 1),
  min_party     INT  NOT NULL DEFAULT 1 CHECK (min_party >= 1),
  UNIQUE (restaurant_id, label)
);
CREATE INDEX IF NOT EXISTS idx_tables_restaurant_capacity
  ON dining_tables (restaurant_id, capacity);

-- One row per (restaurant, local calendar date, meal service). The UTC window
-- is DERIVED from (date_local, start_local/end_local, restaurant.timezone)
-- and materialized on write — so DST shifts are baked in, per date.
CREATE TABLE IF NOT EXISTS service_periods (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  date_local    DATE NOT NULL,             -- restaurant-LOCAL calendar date
  meal          TEXT NOT NULL CHECK (meal IN ('lunch','dinner')),
  start_local   TEXT NOT NULL,             -- "17:30" local wall time
  end_local     TEXT NOT NULL,             -- "23:00" local wall time
  starts_at_utc TIMESTAMPTZ NOT NULL,      -- materialized
  ends_at_utc   TIMESTAMPTZ NOT NULL,      -- materialized
  UNIQUE (restaurant_id, date_local, meal)
);
CREATE INDEX IF NOT EXISTS idx_periods_restaurant_utc
  ON service_periods (restaurant_id, starts_at_utc, ends_at_utc);

CREATE TABLE IF NOT EXISTS reservations (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id        TEXT NOT NULL REFERENCES dining_tables(id),
  party_size      INT  NOT NULL CHECK (party_size >= 1),
  starts_at       TIMESTAMPTZ NOT NULL,    -- UTC
  ends_at         TIMESTAMPTZ NOT NULL,    -- UTC; starts_at < ends_at
  -- held → confirmed → seated → (cancelled | no_show); held → expired
  status          TEXT NOT NULL CHECK (status IN
                    ('held','confirmed','seated','cancelled','no_show','expired')),
  hold_expires_at TIMESTAMPTZ,             -- set iff status = 'held'
  guest_name      TEXT NOT NULL,
  guest_email     TEXT NOT NULL,
  guest_phone     TEXT,
  confirm_code    TEXT NOT NULL UNIQUE,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK ((status = 'held') = (hold_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_res_table_start ON reservations (table_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_res_rest_start  ON reservations (restaurant_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_res_email       ON reservations (guest_email);
CREATE INDEX IF NOT EXISTS idx_res_hold_expiry ON reservations (status, hold_expires_at);

-- I4 — idempotent retries: unique key + the exact first response, stored.
CREATE TABLE IF NOT EXISTS idempotency_records (
  key             TEXT PRIMARY KEY,
  request_hash    TEXT NOT NULL,
  response_json   JSONB NOT NULL,
  response_status INT  NOT NULL,
  reservation_id  TEXT REFERENCES reservations(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only evidence log — every state transition lands here. This is the
-- trail the demo (and judges) can inspect: the system shows its own work.
CREATE TABLE IF NOT EXISTS audit_events (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,                -- hold_created | confirmed | ...
  ref_id     TEXT,                         -- reservation id
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_ref ON audit_events (ref_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- THE INVARIANT (BUILD_PLAN §2.3):
-- No two reservations with status ∈ {held, confirmed} on the same table may
-- have overlapping [starts_at, ends_at) intervals. Violations are rejected by
-- Postgres itself with SQLSTATE 23P01 (exclusion_violation); the API maps
-- that to 409 SLOT_TAKEN. Cancelled/seated/expired rows drop out of the
-- partial predicate, freeing the slot the instant they go terminal.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservation_no_overlap;
ALTER TABLE reservations ADD CONSTRAINT reservation_no_overlap
EXCLUDE USING gist (
  table_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status IN ('held','confirmed'));
