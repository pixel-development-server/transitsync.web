-- ===========================================================================
-- TransitSync 001 — core operational schema
-- Campus shuttle management: users, login sessions, routes, buses, students,
-- RFID scan events, security alerts, audit log and system settings.
-- ===========================================================================

-- Installation marker so the setup wizard knows whether to bootstrap an admin.
CREATE TABLE IF NOT EXISTS system_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  email               TEXT    NOT NULL UNIQUE,
  full_name           TEXT    NOT NULL,
  password_hash       TEXT    NOT NULL,
  phone               TEXT,
  department          TEXT,
  job_title           TEXT,
  status              TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'invited')),
  failed_login_count  INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,
  last_login_at       TEXT,
  last_login_ip       TEXT,
  -- Bumping this invalidates every JWT previously issued to the user.
  token_version       INTEGER NOT NULL DEFAULT 0,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per authenticated browser/device. Revoking a row kills that session only.
CREATE TABLE IF NOT EXISTS login_sessions (
  id              TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip              TEXT,
  user_agent      TEXT,
  device          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id);

-- ---------------------------------------------------------------------------
-- Transport
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  description    TEXT,
  start_point    TEXT    NOT NULL,
  end_point      TEXT    NOT NULL,
  shift          TEXT    NOT NULL DEFAULT 'MORNING'
                   CHECK (shift IN ('MORNING', 'EVENING', 'BOTH')),
  departure_time TEXT    NOT NULL DEFAULT '07:00',
  arrival_time   TEXT    NOT NULL DEFAULT '09:00',
  color          TEXT    NOT NULL DEFAULT '#38BDF8',
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS route_stops (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id       INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  sequence       INTEGER NOT NULL,
  name           TEXT    NOT NULL,
  scheduled_time TEXT,
  latitude       REAL,
  longitude      REAL,
  UNIQUE (route_id, sequence)
);

CREATE TABLE IF NOT EXISTS buses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT    NOT NULL UNIQUE,
  registration_no  TEXT    NOT NULL UNIQUE,
  name             TEXT    NOT NULL,
  make_model       TEXT,
  seat_capacity    INTEGER NOT NULL DEFAULT 40 CHECK (seat_capacity > 0),
  driver_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  driver_name      TEXT,
  driver_phone     TEXT,
  driver_license   TEXT,
  status           TEXT    NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'MAINTENANCE', 'RETIRED')),
  current_route_id INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  odometer_km      INTEGER NOT NULL DEFAULT 0,
  last_service_at  TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_buses_route ON buses(current_route_id);

-- ---------------------------------------------------------------------------
-- Students & RFID
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name        TEXT    NOT NULL,
  college_id       TEXT    NOT NULL UNIQUE,
  email            TEXT,
  phone            TEXT,
  faculty          TEXT,
  program          TEXT,
  semester         INTEGER,
  rfid_serial      TEXT    UNIQUE,
  rfid_status      TEXT    NOT NULL DEFAULT 'UNASSIGNED'
                     CHECK (rfid_status IN ('ACTIVE', 'BLOCKED', 'LOST', 'UNASSIGNED')),
  bus_pass_no      TEXT    UNIQUE,
  pass_valid_from  TEXT,
  pass_valid_to    TEXT,
  route_id         INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  bus_id           INTEGER REFERENCES buses(id) ON DELETE SET NULL,
  pickup_stop      TEXT,
  status           TEXT    NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN')),
  -- Live occupancy pointer maintained by the scan engine.
  onboard_bus_id   INTEGER REFERENCES buses(id) ON DELETE SET NULL,
  onboard_at       TEXT,
  notes            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_students_bus    ON students(bus_id);
CREATE INDEX IF NOT EXISTS idx_students_route  ON students(route_id);
CREATE INDEX IF NOT EXISTS idx_students_onsbus ON students(onboard_bus_id);

-- Every card tap, accepted or rejected. This is the attendance ledger.
CREATE TABLE IF NOT EXISTS scan_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  rfid_serial      TEXT    NOT NULL,
  student_id       INTEGER REFERENCES students(id) ON DELETE SET NULL,
  bus_id           INTEGER REFERENCES buses(id) ON DELETE SET NULL,
  route_id         INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  direction        TEXT    NOT NULL CHECK (direction IN ('BOARD', 'DEBOARD')),
  outcome          TEXT    NOT NULL
                     CHECK (outcome IN ('VALID', 'INVALID', 'EXPIRED',
                                        'UNREGISTERED_BUS', 'UNREGISTERED_CARD')),
  message          TEXT,
  latitude         REAL,
  longitude        REAL,
  gate             TEXT,
  occupancy_after  INTEGER,
  scan_time        TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scan_time    ON scan_events(scan_time DESC);
CREATE INDEX IF NOT EXISTS idx_scan_bus     ON scan_events(bus_id);
CREATE INDEX IF NOT EXISTS idx_scan_student ON scan_events(student_id);
CREATE INDEX IF NOT EXISTS idx_scan_outcome ON scan_events(outcome);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT    NOT NULL,
  severity         TEXT    NOT NULL DEFAULT 'MEDIUM'
                     CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
  title            TEXT    NOT NULL,
  message          TEXT    NOT NULL,
  scan_event_id    INTEGER REFERENCES scan_events(id) ON DELETE SET NULL,
  student_id       INTEGER REFERENCES students(id) ON DELETE SET NULL,
  bus_id           INTEGER REFERENCES buses(id) ON DELETE SET NULL,
  route_id         INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  status           TEXT    NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED')),
  acknowledged_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at  TEXT,
  resolved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at      TEXT,
  resolution_note  TEXT,
  metadata         TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_time   ON alerts(created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action      TEXT    NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail      TEXT,
  ip          TEXT,
  status      TEXT    NOT NULL DEFAULT 'success',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);

-- Key/value system configuration edited from the Settings page.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  label       TEXT,
  group_name  TEXT NOT NULL DEFAULT 'general',
  value_type  TEXT NOT NULL DEFAULT 'string'
                CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
