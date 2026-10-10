-- ===========================================================================
-- TransitSync 003 — visitor button counts
--
-- The Wokwi reader's green Visitor button emits `VISITOR_BUTTON` events. They
-- are not student taps, so they must not touch the attendance ledger; instead
-- they roll up into a per-(bus, route, Nepal-day) counter that the dashboard
-- and live monitor can graph.
--
-- Additive only — nothing here alters an existing column or constraint.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS visitor_counts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nullable bus/route ids cannot participate in a UNIQUE constraint (SQL NULLs
  -- never collide), so a materialised key carries the uniqueness instead.
  scope_key  TEXT    NOT NULL UNIQUE,
  bus_id     INTEGER REFERENCES buses(id)  ON DELETE SET NULL,
  route_id   INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  device_id  TEXT,
  -- Nepali calendar day the presses are bucketed under.
  day        TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  first_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_visitor_counts_day ON visitor_counts(day);
CREATE INDEX IF NOT EXISTS idx_visitor_counts_bus ON visitor_counts(bus_id);
CREATE INDEX IF NOT EXISTS idx_visitor_counts_route ON visitor_counts(route_id);
