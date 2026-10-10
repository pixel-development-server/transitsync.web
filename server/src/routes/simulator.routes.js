import express from 'express';

import { getDb } from '../db/connection.js';
import { asyncHandler, validate } from '../lib/http.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { processTap, evaluateTap, ALERT_TYPES, SIMULATOR_OUTCOMES } from '../services/scanner.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { tapSchema, scenarioSchema } from '../validation/schemas.js';
import { unprocessable } from '../lib/errors.js';

const router = express.Router();

/**
 * The RFID bench.
 *
 * This is intentionally NOT behind the forced-rotation gate only — it still needs
 * `simulator:scan`, so an attendant (read-only) cannot drive the simulator.
 */
router.use(requireAuth);
router.use(requirePermission('simulator:scan'));

/** Reader hardware + card samples so the widget is immediately usable. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();

    const buses = db
      .prepare(
        `SELECT b.id, b.code, b.name, b.seat_capacity, b.current_route_id,
                r.code AS route_code,
                (SELECT COUNT(*) FROM students s WHERE s.onboard_bus_id = b.id) AS occupancy
           FROM buses b LEFT JOIN routes r ON r.id = b.current_route_id
          WHERE b.status <> 'RETIRED' ORDER BY b.code`,
      )
      .all()
      .map((bus) => ({
        id: bus.id,
        code: bus.code,
        name: bus.name,
        seatCapacity: bus.seat_capacity,
        occupancy: bus.occupancy,
        routeCode: bus.route_code,
        utilization: bus.seat_capacity ? Math.round((bus.occupancy / bus.seat_capacity) * 100) : 0,
      }));

    // Curated samples — one card per outcome the engine can produce.
    const samples = db
      .prepare(
        `SELECT s.id, s.full_name, s.college_id, s.rfid_serial, s.card_status,
                s.card_issued_at, s.status, s.bus_id, s.route_id,
                b.code AS bus_code,
                (SELECT r.code FROM routes r WHERE r.id = s.route_id) AS route_code
           FROM students s LEFT JOIN buses b ON b.id = s.bus_id
          WHERE s.rfid_serial IS NOT NULL
          ORDER BY s.id DESC LIMIT 60`,
      )
      .all();

    const pick = (predicate, fallbackSerial) => {
      const match = samples.find(predicate);
      if (match) return { ...match, synthetic: false };
      return {
        id: null,
        full_name: 'Unknown card holder',
        college_id: '—',
        rfid_serial: fallbackSerial,
        card_status: 'UNASSIGNED',
        card_issued_at: null,
        status: 'UNKNOWN',
        bus_id: null,
        route_id: null,
        bus_code: null,
        route_code: null,
        synthetic: true,
      };
    };

    const presets = [
      {
        outcome: 'VALID',
        label: 'Valid boarding pass',
        tone: 'emerald',
        description: 'Registered card, active student, active card, correct bus.',
        card: pick(
          (row) => row.status === 'ACTIVE' && row.card_status === 'ACTIVE',
          'TS-DEMO0001',
        ),
      },
      {
        outcome: 'INVALID',
        label: 'Revoked / suspended card',
        tone: 'rose',
        description: 'Card has been revoked, or the student is suspended.',
        card: pick(
          (row) => row.card_status === 'REVOKED' || row.status !== 'ACTIVE',
          'TS-REVOKED1',
        ),
      },
      {
        outcome: 'UNREGISTERED_BUS',
        label: 'Unauthorized route',
        tone: 'orange',
        description: 'Valid card tapping a bus it is not allocated to.',
        card: pick((row) => row.bus_id === null, 'TS-NOALLOC01'),
      },
      {
        outcome: 'UNREGISTERED_CARD',
        label: 'Unregistered device',
        tone: 'red',
        description: 'Serial that exists nowhere in the registry.',
        card: pick(() => false, 'TS-GHOST-9F3A21'),
      },
    ];

    res.json({
      success: true,
      data: {
        readers: buses,
        outcomes: SIMULATOR_OUTCOMES,
        outcomeMeta: Object.fromEntries(
          Object.entries(ALERT_TYPES).map(([key, value]) => [key, { label: value.label, severity: value.severity }]),
        ),
        presets,
        recent: db
          .prepare(
            `SELECT id, rfid_serial, direction, outcome, message, scan_time, occupancy_after
               FROM scan_events ORDER BY id DESC LIMIT 12`,
          )
          .all(),
      },
    });
  }),
);

/** Dry-run: explain the verdict without writing anything. */
router.post(
  '/preview',
  validate(tapSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const bus = req.body.busId
      ? db.prepare('SELECT * FROM buses WHERE id = ?').get(req.body.busId)
      : db.prepare("SELECT * FROM buses WHERE status = 'ACTIVE' ORDER BY id LIMIT 1").get();

    const student = db
      .prepare('SELECT * FROM students WHERE UPPER(rfid_serial) = ?')
      .get(String(req.body.rfidSerial).toUpperCase());

    const verdict = evaluateTap({
      student,
      bus,
      today: new Date().toISOString().slice(0, 10),
    });

    res.json({
      success: true,
      data: {
        outcome: verdict.outcome,
        message: verdict.message,
        // Only an unknown UID raises an Unregistered Alert.
        wouldAlert: Boolean(verdict.alertType),
        alertLabel: verdict.alertType ? ALERT_TYPES[verdict.alertType].label : null,
        knownStudent: Boolean(student),
      },
    });
  }),
);

/** Fire a tap through the real engine. */
router.post(
  '/tap',
  validate(tapSchema),
  asyncHandler(async (req, res) => {
    const result = processTap(req.body);
    recordAudit(
      fromRequest(req, 'simulator.tap', {
        entity: 'scan_event',
        entityId: result.scan.id,
        detail: { serial: result.scan.rfid_serial, outcome: result.outcome, bus: result.bus?.code ?? null },
      }),
    );
    res.json({ success: true, data: result });
  }),
);

/**
 * Drive a specific outcome. Picks a matching card from the registry (falling back
 * to mutating a scratch record) so QA can exercise every branch on demand.
 */
router.post(
  '/scenario/:outcome',
  validate(scenarioSchema),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const outcome = req.params.outcome;
    if (!SIMULATOR_OUTCOMES.includes(outcome)) {
      throw unprocessable(`Unknown scenario "${outcome}".`, [
        { field: 'outcome', message: `Must be one of: ${SIMULATOR_OUTCOMES.join(', ')}` },
      ]);
    }

    const buses = db.prepare("SELECT * FROM buses WHERE status <> 'RETIRED' ORDER BY id").all();
    const bus = req.body.busId ? buses.find((entry) => entry.id === req.body.busId) : buses[0];
    if (!bus) {
      return res.status(409).json({
        success: false,
        error: { code: 'NO_BUS', message: 'Add at least one bus before running scenarios.' },
      });
    }

    const serial = (() => {
      switch (outcome) {
        case 'VALID': {
          const row = db
            .prepare(
              `SELECT rfid_serial FROM students
                WHERE rfid_serial IS NOT NULL AND status = 'ACTIVE' AND card_status = 'ACTIVE'
                  AND bus_id = ?
                LIMIT 1`,
            )
            .get(bus.id);
          return row?.rfid_serial ?? 'TS-SCEN-VALID';
        }
        case 'INVALID': {
          const row = db
            .prepare(
              `SELECT rfid_serial FROM students
                WHERE rfid_serial IS NOT NULL AND (card_status = 'REVOKED' OR status <> 'ACTIVE')
                LIMIT 1`,
            )
            .get();
          return row?.rfid_serial ?? 'TS-SCEN-INVALID';
        }
        case 'UNREGISTERED_BUS': {
          const row = db
            .prepare(
              `SELECT rfid_serial FROM students
                WHERE rfid_serial IS NOT NULL AND card_status = 'ACTIVE'
                  AND (bus_id IS NULL OR bus_id <> ?) LIMIT 1`,
            )
            .get(bus.id);
          return row?.rfid_serial ?? 'TS-SCEN-WRONGBUS';
        }
        default:
          return `TS-GHOST-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
      }
    })();

    // A scratch student backs synthetic serials so the tap lands on a real record
    // where the outcome depends on student state (valid / invalid).
    if (serial.startsWith('TS-SCEN-') && outcome !== 'UNREGISTERED_BUS') {
      const scratchSerial = serial;
      const existing = db.prepare('SELECT id FROM students WHERE rfid_serial = ?').get(scratchSerial);
      if (existing) db.prepare('DELETE FROM students WHERE id = ?').run(existing.id);

      const revoked = outcome === 'INVALID';
      db.prepare(
        `INSERT INTO students (full_name, college_id, rfid_serial, rfid_status, card_status, status, bus_id)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      ).run(
        revoked ? 'Revoked Test Student' : 'Scenario Test Student',
        `SCEN-${scratchSerial.slice(-7)}`,
        scratchSerial,
        revoked ? 'BLOCKED' : 'ACTIVE',
        revoked ? 'REVOKED' : 'ACTIVE',
        bus.id,
      );
    }

    const result = processTap({
      rfidSerial: serial,
      busId: bus.id,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      gate: req.body.gate ?? 'Simulator',
    });

    recordAudit(
      fromRequest(req, 'simulator.scenario', {
        entity: 'scan_event',
        entityId: result.scan.id,
        detail: { requested: outcome, actual: result.outcome, serial },
      }),
    );

    res.json({
      success: true,
      data: { ...result, requestedOutcome: outcome, matchedOutcome: result.outcome },
    });
  }),
);

export default router;
