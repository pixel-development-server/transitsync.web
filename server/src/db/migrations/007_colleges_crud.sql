-- ===========================================================================
-- TransitSync 007 — college deletion lifecycle
--
-- `institutions.status` is constrained to ACTIVE/SUSPENDED, so a deleted
-- campus cannot be expressed through status alone. This migration adds a
-- nullable `deleted_at` tombstone: a campus rows gains `deleted_at` when the
-- Super Administrator purges it, its staff sessions are revoked, and the
-- platform data providers (`services/colleges.js`, the master panel list)
-- stop surfacing it. Status and role data are left untouched, so suspending or
-- later re-checking a tombstoned campus still works from raw SQL.
--
-- A full hard purge (`DELETE /api/super-admin/colleges/:id?purge=true`) still
-- deletes the institution row itself; `deleted_at` serves the soft-delete
-- default and is never required for it.
-- ===========================================================================

ALTER TABLE institutions ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_institutions_deleted_at ON institutions(deleted_at);