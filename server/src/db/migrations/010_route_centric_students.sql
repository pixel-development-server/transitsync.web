-- ===========================================================================
-- TransitSync 010 — route-centric student model
-- ===========================================================================
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS students_new (
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
  status           TEXT    NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN')),
  onboard_bus_id   INTEGER REFERENCES buses(id) ON DELETE SET NULL,
  onboard_at       TEXT,
  notes            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  tenant_id        TEXT    REFERENCES institutions(id) ON DELETE RESTRICT,
  card_status      TEXT    NOT NULL DEFAULT 'UNASSIGNED',
  card_issued_at   TEXT,
  card_revoked_at  TEXT,
  card_revoked_reason TEXT
);

INSERT INTO students_new (
  id, full_name, college_id, email, phone, faculty, program, semester,
  rfid_serial, rfid_status, bus_pass_no, pass_valid_from, pass_valid_to,
  status, onboard_bus_id, onboard_at, notes, created_at, updated_at, tenant_id,
  card_status, card_issued_at, card_revoked_at, card_revoked_reason
)
SELECT
  id, full_name, college_id, email, phone, faculty, program, semester,
  rfid_serial, rfid_status, bus_pass_no, pass_valid_from, pass_valid_to,
  status, onboard_bus_id, onboard_at, notes, created_at, updated_at, tenant_id,
  card_status, card_issued_at, card_revoked_at, card_revoked_reason
FROM students;

DROP TABLE students;
ALTER TABLE students_new RENAME TO students;

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_college_id ON students(college_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_rfid_serial_unique ON students(rfid_serial);
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_pass_no_unique ON students(bus_pass_no);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);
CREATE INDEX IF NOT EXISTS idx_students_onsbus ON students(onboard_bus_id);
CREATE INDEX IF NOT EXISTS idx_students_tenant ON students(tenant_id);
CREATE INDEX IF NOT EXISTS idx_students_card_status ON students(card_status);

PRAGMA foreign_keys = ON;
