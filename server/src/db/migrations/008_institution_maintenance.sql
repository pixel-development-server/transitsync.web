-- ===========================================================================
-- TransitSync 008 — tenant-scoped maintenance mode
--
-- Maintenance is currently a single platform-wide flag in `settings`
-- (`maintenance_mode`), which a maintenance window for one campus would force
-- onto every other institution on the platform. This migration moves the
-- switch onto the `institutions` row itself so a campus can enter maintenance
-- without touching anyone else:
--
--   * `is_maintenance_mode` — boolean (0/1) flag, default off.
--   * `maintenance_message` — copy shown to that campus's users, defaulting to
--     the standard "this campus is under maintenance" notice.
--
-- The platform-wide `settings` flag remains for a global maintenance window
-- (only the Level 200 Super Administrator can bypass that one); the two gates
-- are layered in the login flow and the `authenticate` middleware.
-- ===========================================================================

ALTER TABLE institutions ADD COLUMN is_maintenance_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE institutions ADD COLUMN maintenance_message TEXT NOT NULL DEFAULT 'This campus transport system is currently under maintenance.';