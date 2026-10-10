-- ===========================================================================
-- TransitSync 004 — college-issued bus cards (Issued / Active / Revoked)
--
-- Replaces the previous subscription/expiry model. A bus card is a physical
-- RFID card issued by the college administration when a student pays the bus
-- fee and submits a registration form. The card remains active until the
-- student formally cancels their bus service, at which point the college
-- revokes and retrieves it.
--
-- Additive by design: the legacy `rfid_status` and pass columns are retained so
-- historical rows stay readable, but `card_status` is now authoritative for the
-- decision engine, the registry UI and the API.
--
--   card_status  UNASSIGNED | ISSUED | ACTIVE | REVOKED
--   ISSUED       printed/assigned, not yet handed to the student
--   ACTIVE       in the student's possession and usable for boarding
--   REVOKED      cancelled, lost or blocked — the college has retrieved it
-- ===========================================================================

ALTER TABLE students ADD COLUMN card_status TEXT NOT NULL DEFAULT 'UNASSIGNED';
ALTER TABLE students ADD COLUMN card_issued_at TEXT;
ALTER TABLE students ADD COLUMN card_revoked_at TEXT;
ALTER TABLE students ADD COLUMN card_revoked_reason TEXT;

-- Backfill from the old model: a bound serial with an active legacy status is an
-- ACTIVE card; BLOCKED/LOST become REVOKED; everything else is UNASSIGNED.
UPDATE students SET
  card_status = CASE
    WHEN rfid_serial IS NULL OR TRIM(rfid_serial) = '' THEN 'UNASSIGNED'
    WHEN rfid_status IN ('BLOCKED', 'LOST') THEN 'REVOKED'
    ELSE 'ACTIVE'
  END,
  card_issued_at = CASE
    WHEN rfid_serial IS NOT NULL AND TRIM(rfid_serial) <> '' THEN COALESCE(created_at, datetime('now'))
    ELSE NULL
  END,
  card_revoked_at = CASE
    WHEN rfid_status IN ('BLOCKED', 'LOST') THEN datetime('now')
    ELSE NULL
  END,
  card_revoked_reason = CASE
    WHEN rfid_status = 'BLOCKED' THEN 'blocked'
    WHEN rfid_status = 'LOST' THEN 'lost'
    ELSE NULL
  END;

CREATE INDEX IF NOT EXISTS idx_students_card_status ON students(card_status);
