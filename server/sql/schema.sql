-- ===========================================================================
-- TransitSync — complete MariaDB/MySQL schema (XAMPP stack)
-- ===========================================================================
-- Single source of truth for the database, consolidating every legacy
-- migration into one idempotent DDL script. Applied by
-- `server/src/db/migrate.js` and validated before boot by `server/supervisor.js`.
--
-- Conventions
--   * Engine: InnoDB, charset utf8mb4 / collation utf8mb4_general_ci (the
--     XAMPP MariaDB default — deliberately not a MySQL-8-only collation, so
--     the same DDL applies on either engine).
--   * Timestamps: DATETIME. The application pool opens every session at Nepal
--     Standard Time (+05:45), so `CURRENT_TIMESTAMP` / `NOW()` persist NPT wall
--     time — the whole system is synchronised to NPT as required by the
--     project proposal. `dateStrings: true` on the pool returns them as plain
--     `YYYY-MM-DD HH:MM:SS` strings, matching what the code expects.
--   * Surrogate keys: INT AUTO_INCREMENT (surfaced to JS as Number).
--   * Booleans: TINYINT(1) 0/1 (identical to the SQLite INTEGER flags).
--   * Foreign keys: declared with the same ON DELETE semantics the migrations
--     used, so delete behaviour is preserved exactly.
--   * Every statement is IF NOT EXISTS so the script can re-run safely.
-- ===========================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- Core reference tables (no inbound dependencies)
-- ---------------------------------------------------------------------------

-- Campus / tenant. Fixed default row keeps the single-campus install working.
CREATE TABLE IF NOT EXISTS institutions (
  id                  VARCHAR(64)  NOT NULL PRIMARY KEY,
  name                VARCHAR(255) NOT NULL,
  code                VARCHAR(100) NOT NULL,
  status              VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at          DATETIME     NULL,
  is_maintenance_mode TINYINT(1)   NOT NULL DEFAULT 0,
  maintenance_message VARCHAR(500) NOT NULL
                        DEFAULT 'This campus transport system is currently under maintenance.',
  UNIQUE KEY uq_institutions_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Authorised Google Workspace / institutional email domains per campus.
-- A domain belongs to exactly one institution; this is the authoritative
-- mapping used by POST /api/auth/google to place a Google user in the right
-- tenant. Domains are also discovered from existing campus administrator
-- emails when a campus is provisioned without an explicit list.
CREATE TABLE IF NOT EXISTS institution_email_domains (
  domain         VARCHAR(255) NOT NULL,
  institution_id VARCHAR(64)  NOT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (domain),
  KEY idx_ied_institution (institution_id),
  CONSTRAINT fk_ied_institution FOREIGN KEY (institution_id)
    REFERENCES institutions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- RBAC role catalogue.
CREATE TABLE IF NOT EXISTS roles (
  id          INT         NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `key`       VARCHAR(100) NOT NULL,
  name        VARCHAR(150) NOT NULL,
  description TEXT         NULL,
  level       INT          NOT NULL DEFAULT 0,
  is_system   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_roles_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Permission catalogue (`module:action`).
CREATE TABLE IF NOT EXISTS permissions (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `key`        VARCHAR(150) NOT NULL,
  module       VARCHAR(100) NOT NULL,
  module_label VARCHAR(150) NOT NULL,
  `action`     VARCHAR(100) NOT NULL,
  label        VARCHAR(200) NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_permissions_key (`key`),
  KEY idx_permissions_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                    INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email                 VARCHAR(255) NOT NULL,
  full_name             VARCHAR(255) NOT NULL,
  password_hash         VARCHAR(255) NOT NULL,
  phone                 VARCHAR(50)  NULL,
  department            VARCHAR(150) NULL,
  job_title             VARCHAR(150) NULL,
  status                VARCHAR(20)  NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'invited')),
  failed_login_count    INT          NOT NULL DEFAULT 0,
  locked_until          DATETIME     NULL,
  last_login_at         DATETIME     NULL,
  last_login_ip         VARCHAR(64)  NULL,
  -- Bumping this invalidates every JWT previously issued to the user.
  token_version         INT          NOT NULL DEFAULT 0,
  created_by            INT          NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 002 — credential lifecycle / RBAC linkage
  role_id               INT          NULL,
  is_first_login        TINYINT(1)   NOT NULL DEFAULT 1,
  password_changed      TINYINT(1)   NOT NULL DEFAULT 0,
  force_password_reset  TINYINT(1)   NOT NULL DEFAULT 0,
  permissions_mode      VARCHAR(20)  NOT NULL DEFAULT 'INHERIT'
                          CHECK (permissions_mode IN ('INHERIT', 'CUSTOM')),
  last_password_change  DATETIME     NULL,
  -- 005 — tenancy
  tenant_id             VARCHAR(64)  NULL,
  -- 009 — platform-owner 2FA
  two_factor_method     VARCHAR(20)  NULL,
  totp_secret           VARCHAR(255) NULL,
  two_factor_enabled    TINYINT(1)   NOT NULL DEFAULT 0,
  two_factor_confirmed_at DATETIME   NULL,
  recovery_codes        TEXT         NULL,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role_id),
  KEY idx_users_status (status),
  KEY idx_users_tenant (tenant_id),
  CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL,
  CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES institutions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Remembered-device registry (12). One row per (user, fingerprint).
CREATE TABLE IF NOT EXISTS user_devices (
  id                 INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id            INT          NOT NULL,
  device_fingerprint VARCHAR(255) NOT NULL,
  device_label       VARCHAR(255) NULL,
  user_agent         TEXT         NULL,
  last_ip            VARCHAR(64)  NULL,
  trusted            TINYINT(1)   NOT NULL DEFAULT 1,
  first_seen_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at      DATETIME     NULL,
  login_count        INT          NOT NULL DEFAULT 0,
  revoked_at         DATETIME     NULL,
  revoked_reason     VARCHAR(255) NULL,
  -- A fingerprint may only be registered once per account.
  UNIQUE KEY uq_user_devices_user_fp (user_id, device_fingerprint),
  KEY idx_user_devices_fingerprint (device_fingerprint),
  CONSTRAINT fk_user_devices_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- One row per authenticated browser/device. Revoking a row kills that session.
CREATE TABLE IF NOT EXISTS login_sessions (
  id             VARCHAR(64)  NOT NULL PRIMARY KEY,
  user_id        INT          NOT NULL,
  ip             VARCHAR(64)  NULL,
  user_agent     TEXT         NULL,
  device         VARCHAR(255) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     DATETIME     NOT NULL,
  revoked_at     DATETIME     NULL,
  revoked_reason VARCHAR(255) NULL,
  -- 012 — session ↔ device traceability
  device_id      INT          NULL,
  remembered     TINYINT(1)   NOT NULL DEFAULT 0,
  KEY idx_login_sessions_user (user_id),
  KEY idx_login_sessions_device (device_id),
  CONSTRAINT fk_login_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_login_sessions_device FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Pending password-verified sign-in awaiting its second factor (009).
CREATE TABLE IF NOT EXISTS login_challenges (
  id          VARCHAR(64)  NOT NULL PRIMARY KEY,
  user_id     INT          NOT NULL,
  method      VARCHAR(20)  NOT NULL,
  remember    TINYINT(1)   NOT NULL DEFAULT 0,
  ip          VARCHAR(64)  NULL,
  user_agent  TEXT         NULL,
  device      VARCHAR(255) NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  consumed_at DATETIME     NULL,
  expires_at  DATETIME     NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_login_challenges_user (user_id),
  CONSTRAINT fk_login_challenges_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Short-lived email one-time codes (009).
CREATE TABLE IF NOT EXISTS email_otp_codes (
  id          VARCHAR(64)  NOT NULL PRIMARY KEY,
  user_id     INT          NOT NULL,
  code_hash   VARCHAR(255) NOT NULL,
  purpose     VARCHAR(50)  NOT NULL DEFAULT 'LOGIN_2FA',
  attempts    INT          NOT NULL DEFAULT 0,
  consumed_at DATETIME     NULL,
  expires_at  DATETIME     NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_email_otp_user (user_id),
  CONSTRAINT fk_email_otp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Role → permission grants.
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INT      NOT NULL,
  permission_id INT      NOT NULL,
  granted_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_perm FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Per-user deviation from the role (`effect` = GRANT | DENY).
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id       INT          NOT NULL,
  permission_id INT          NOT NULL,
  effect        VARCHAR(10)  NOT NULL DEFAULT 'GRANT'
                  CHECK (effect IN ('GRANT', 'DENY')),
  granted_by    INT          NULL,
  granted_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, permission_id),
  CONSTRAINT fk_user_permissions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_permissions_perm FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_permissions_by FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Transport network
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code           VARCHAR(50)  NOT NULL,
  name           VARCHAR(150) NOT NULL,
  description    TEXT         NULL,
  start_point    VARCHAR(150) NOT NULL,
  end_point      VARCHAR(150) NOT NULL,
  shift          VARCHAR(20)  NOT NULL DEFAULT 'MORNING'
                   CHECK (shift IN ('MORNING', 'EVENING', 'BOTH')),
  departure_time VARCHAR(10)  NOT NULL DEFAULT '07:00',
  arrival_time   VARCHAR(10)  NOT NULL DEFAULT '09:00',
  color          VARCHAR(20)  NOT NULL DEFAULT '#38BDF8',
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id      VARCHAR(64)  NULL,
  UNIQUE KEY uq_routes_code (code),
  KEY idx_routes_tenant (tenant_id),
  CONSTRAINT fk_routes_tenant FOREIGN KEY (tenant_id) REFERENCES institutions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS route_stops (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  route_id       INT          NOT NULL,
  sequence       INT          NOT NULL,
  name           VARCHAR(150) NOT NULL,
  scheduled_time VARCHAR(10)  NULL,
  latitude       DOUBLE       NULL,
  longitude      DOUBLE       NULL,
  UNIQUE KEY uq_route_stops_route_seq (route_id, sequence),
  CONSTRAINT fk_route_stops_route FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS buses (
  id               INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code             VARCHAR(50)  NOT NULL,
  registration_no  VARCHAR(50)  NOT NULL,
  name             VARCHAR(150) NOT NULL,
  make_model       VARCHAR(150) NULL,
  seat_capacity    INT          NOT NULL DEFAULT 40 CHECK (seat_capacity > 0),
  driver_user_id   INT          NULL,
  driver_name      VARCHAR(150) NULL,
  driver_phone     VARCHAR(50)  NULL,
  driver_license   VARCHAR(50)  NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'MAINTENANCE', 'RETIRED')),
  current_route_id INT          NULL,
  odometer_km      INT          NOT NULL DEFAULT 0,
  last_service_at  DATETIME     NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id        VARCHAR(64)  NULL,
  UNIQUE KEY uq_buses_code (code),
  UNIQUE KEY uq_buses_registration (registration_no),
  KEY idx_buses_route (current_route_id),
  KEY idx_buses_tenant (tenant_id),
  CONSTRAINT fk_buses_driver FOREIGN KEY (driver_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_buses_route FOREIGN KEY (current_route_id) REFERENCES routes(id) ON DELETE SET NULL,
  CONSTRAINT fk_buses_tenant FOREIGN KEY (tenant_id) REFERENCES institutions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Students (route-centric model after 010/011)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  id                 INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  full_name          VARCHAR(255) NOT NULL,
  college_id         VARCHAR(100) NOT NULL,
  email              VARCHAR(255) NULL,
  phone              VARCHAR(50)  NULL,
  faculty            VARCHAR(150) NULL,
  program            VARCHAR(150) NULL,
  semester           INT          NULL,
  rfid_serial        VARCHAR(100) NULL,
  rfid_status        VARCHAR(20)  NOT NULL DEFAULT 'UNASSIGNED'
                       CHECK (rfid_status IN ('ACTIVE', 'BLOCKED', 'LOST', 'UNASSIGNED')),
  bus_pass_no        VARCHAR(100) NULL,
  pass_valid_from    VARCHAR(32)  NULL,
  pass_valid_to      VARCHAR(32)  NULL,
  status             VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN')),
  -- Live occupancy pointer maintained by the scan engine.
  onboard_bus_id     INT          NULL,
  onboard_at         DATETIME     NULL,
  notes              TEXT         NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id          VARCHAR(64)  NULL,
  -- 004 — card lifecycle
  card_status        VARCHAR(20)  NOT NULL DEFAULT 'UNASSIGNED',
  card_issued_at     DATETIME     NULL,
  card_revoked_at    DATETIME     NULL,
  card_revoked_reason VARCHAR(255) NULL,
  -- 006/011 — roster ↔ sign-in account link
  user_id            INT          NULL,
  is_claimed         TINYINT(1)   NOT NULL DEFAULT 0,
  UNIQUE KEY uq_students_college_id (college_id),
  UNIQUE KEY uq_students_rfid_serial (rfid_serial),
  UNIQUE KEY uq_students_bus_pass_no (bus_pass_no),
  KEY idx_students_status (status),
  KEY idx_students_onsbus (onboard_bus_id),
  KEY idx_students_tenant (tenant_id),
  KEY idx_students_user_id (user_id),
  KEY idx_students_card_status (card_status),
  KEY idx_students_email_lookup (tenant_id, email),
  CONSTRAINT fk_students_onboard FOREIGN KEY (onboard_bus_id) REFERENCES buses(id) ON DELETE SET NULL,
  CONSTRAINT fk_students_tenant FOREIGN KEY (tenant_id) REFERENCES institutions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_students_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Attendance ledger & derived records
-- ---------------------------------------------------------------------------
-- Every card tap, accepted or rejected.
CREATE TABLE IF NOT EXISTS scan_events (
  id              INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rfid_serial     VARCHAR(100) NOT NULL,
  student_id      INT          NULL,
  bus_id          INT          NULL,
  route_id        INT          NULL,
  direction       VARCHAR(10)  NOT NULL CHECK (direction IN ('BOARD', 'DEBOARD')),
  outcome         VARCHAR(30)  NOT NULL
                    CHECK (outcome IN ('VALID', 'INVALID', 'EXPIRED',
                                       'UNREGISTERED_BUS', 'UNREGISTERED_CARD')),
  message         TEXT         NULL,
  latitude        DOUBLE       NULL,
  longitude       DOUBLE       NULL,
  gate            VARCHAR(100) NULL,
  occupancy_after INT          NULL,
  scan_time       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id       VARCHAR(64)  NULL,
  KEY idx_scan_time (scan_time),
  KEY idx_scan_bus (bus_id),
  KEY idx_scan_student (student_id),
  KEY idx_scan_outcome (outcome),
  KEY idx_scan_events_tenant (tenant_id),
  CONSTRAINT fk_scan_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL,
  CONSTRAINT fk_scan_bus FOREIGN KEY (bus_id) REFERENCES buses(id) ON DELETE SET NULL,
  CONSTRAINT fk_scan_route FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE SET NULL,
  CONSTRAINT fk_scan_tenant FOREIGN KEY (tenant_id) REFERENCES institutions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Visitor-button presses bucketed per (bus, route, NPT-day).
CREATE TABLE IF NOT EXISTS visitor_counts (
  id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- Nullable bus/route ids never collide under UNIQUE, so a materialised key
  -- carries the uniqueness instead.
  scope_key  VARCHAR(255) NOT NULL,
  bus_id     INT          NULL,
  route_id   INT          NULL,
  device_id  VARCHAR(100) NULL,
  day        DATE         NOT NULL,
  count      INT          NOT NULL DEFAULT 0,
  first_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_visitor_counts_scope (scope_key),
  KEY idx_visitor_counts_day (day),
  KEY idx_visitor_counts_bus (bus_id),
  KEY idx_visitor_counts_route (route_id),
  CONSTRAINT fk_visitor_bus FOREIGN KEY (bus_id) REFERENCES buses(id) ON DELETE SET NULL,
  CONSTRAINT fk_visitor_route FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Daily route/bus bookings (rider portal). One per (student, travel_date).
CREATE TABLE IF NOT EXISTS student_bookings (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id  INT          NOT NULL,
  route_id    INT          NULL,
  bus_id      INT          NULL,
  -- Nepali calendar day (`YYYY-MM-DD`) the trip is booked for.
  travel_date DATE         NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'BOOKED'
                CHECK (status IN ('BOOKED', 'CANCELLED', 'COMPLETED')),
  seat_no     VARCHAR(20)  NULL,
  notes       TEXT         NULL,
  tenant_id   VARCHAR(64)  NULL,
  created_by  INT          NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_bookings_day (student_id, travel_date),
  KEY idx_student_bookings_day (travel_date, status),
  KEY idx_student_bookings_route (route_id, travel_date),
  KEY idx_student_bookings_tenant (tenant_id),
  CONSTRAINT fk_bookings_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_bookings_route FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE SET NULL,
  CONSTRAINT fk_bookings_bus FOREIGN KEY (bus_id) REFERENCES buses(id) ON DELETE SET NULL,
  CONSTRAINT fk_bookings_tenant FOREIGN KEY (tenant_id) REFERENCES institutions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bookings_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Security & operations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id               INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type             VARCHAR(100) NOT NULL,
  severity         VARCHAR(20)  NOT NULL DEFAULT 'MEDIUM'
                     CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
  title            VARCHAR(255) NOT NULL,
  message          TEXT         NOT NULL,
  scan_event_id    INT          NULL,
  student_id       INT          NULL,
  bus_id           INT          NULL,
  route_id         INT          NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED')),
  acknowledged_by  INT          NULL,
  acknowledged_at  DATETIME     NULL,
  resolved_by      INT          NULL,
  resolved_at      DATETIME     NULL,
  resolution_note  TEXT         NULL,
  metadata         TEXT         NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id        VARCHAR(64)  NULL,
  KEY idx_alerts_status (status),
  KEY idx_alerts_time (created_at),
  KEY idx_alerts_tenant (tenant_id),
  CONSTRAINT fk_alerts_scan FOREIGN KEY (scan_event_id) REFERENCES scan_events(id) ON DELETE SET NULL,
  CONSTRAINT fk_alerts_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL,
  CONSTRAINT fk_alerts_bus FOREIGN KEY (bus_id) REFERENCES buses(id) ON DELETE SET NULL,
  CONSTRAINT fk_alerts_route FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE SET NULL,
  CONSTRAINT fk_alerts_ack_by FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_alerts_res_by FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_alerts_tenant FOREIGN KEY (tenant_id) REFERENCES institutions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NULL,
  actor_email VARCHAR(255) NULL,
  action      VARCHAR(150) NOT NULL,
  entity      VARCHAR(100) NULL,
  entity_id   VARCHAR(100) NULL,
  detail      TEXT         NULL,
  ip          VARCHAR(64)  NULL,
  status      VARCHAR(50)  NOT NULL DEFAULT 'success',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_user (user_id),
  KEY idx_audit_time (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Key/value system configuration edited from the Settings page.
CREATE TABLE IF NOT EXISTS settings (
  `key`       VARCHAR(150) NOT NULL PRIMARY KEY,
  value       TEXT         NOT NULL,
  label       VARCHAR(255) NULL,
  group_name  VARCHAR(100) NOT NULL DEFAULT 'general',
  value_type  VARCHAR(20)  NOT NULL DEFAULT 'string'
                CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  updated_by  INT          NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Installation marker so the setup wizard knows whether to bootstrap an admin.
CREATE TABLE IF NOT EXISTS system_meta (
  `key`      VARCHAR(150) NOT NULL PRIMARY KEY,
  value      TEXT         NOT NULL,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Tracks which DDL revisions have been applied (used by migrate.js).
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   VARCHAR(150) NOT NULL PRIMARY KEY,
  checksum   VARCHAR(64)  NOT NULL,
  applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
-- Default tenant (fixed UUID so fresh installs and the backfill agree).
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO institutions (id, name, code, status)
  VALUES ('11111111-1111-4111-8111-111111111111', 'Itahari International College', 'iic', 'ACTIVE');

-- Default campus' institutional domain. Derive the tenant id from the campus
-- code: existing installs created this institution with a generated UUID, so a
-- hardcoded id would silently miss (FK-ignored) on those databases. Extra
-- domains can be registered from the Platform Master → College Management
-- screen or inferred from the campus administrator's email on every migrate.
INSERT IGNORE INTO institution_email_domains (domain, institution_id)
  SELECT 'iic.edu.np', id FROM institutions WHERE code = 'iic';
