-- ===========================================================================
-- TransitSync 005 — multi-tenancy foundation
--
-- Introduces `institutions` (colleges) and a nullable `tenant_id` on every
-- campus-scoped table. This migration is ADDITIVE and NON-DESTRUCTIVE: every
-- existing row is backfilled to the single default tenant, so the current
-- single-campus deployment keeps working with zero query changes. Row-level
-- tenant filtering in the API is intentionally deferred — today one institution
-- (`iic`) owns every row, and new campuses provisioned from the Super Admin
-- panel carry their own records.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS institutions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The campus this deployment was originally built around. Fixed UUID so the
-- backfill below and every fresh install agree on the default tenant id.
INSERT OR IGNORE INTO institutions (id, name, code, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Itahari International College', 'iic', 'ACTIVE');

-- Nullable REFERENCES columns: SQLite only permits this when the default is NULL,
-- which is exactly what we want before the backfill.
ALTER TABLE users       ADD COLUMN tenant_id TEXT REFERENCES institutions(id);
ALTER TABLE students    ADD COLUMN tenant_id TEXT REFERENCES institutions(id);
ALTER TABLE buses       ADD COLUMN tenant_id TEXT REFERENCES institutions(id);
ALTER TABLE routes      ADD COLUMN tenant_id TEXT REFERENCES institutions(id);
ALTER TABLE scan_events ADD COLUMN tenant_id TEXT REFERENCES institutions(id);
ALTER TABLE alerts      ADD COLUMN tenant_id TEXT REFERENCES institutions(id);

-- Attach every pre-existing row to the default campus.
UPDATE users       SET tenant_id = '11111111-1111-4111-8111-111111111111' WHERE tenant_id IS NULL;
UPDATE students    SET tenant_id = '11111111-1111-4111-8111-111111111111' WHERE tenant_id IS NULL;
UPDATE buses       SET tenant_id = '11111111-1111-4111-8111-111111111111' WHERE tenant_id IS NULL;
UPDATE routes      SET tenant_id = '11111111-1111-4111-8111-111111111111' WHERE tenant_id IS NULL;
UPDATE scan_events SET tenant_id = '11111111-1111-4111-8111-111111111111' WHERE tenant_id IS NULL;
UPDATE alerts      SET tenant_id = '11111111-1111-4111-8111-111111111111' WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_tenant       ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_students_tenant    ON students(tenant_id);
CREATE INDEX IF NOT EXISTS idx_buses_tenant       ON buses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_routes_tenant      ON routes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_scan_events_tenant ON scan_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant      ON alerts(tenant_id);
