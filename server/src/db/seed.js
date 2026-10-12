import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';

import config from '../config/env.js';
import { getDb, closeDb } from './connection.js';
import { runMigrations } from './migrate.js';
import { ROLE_KEYS } from './permissions.js';
import { DEFAULT_TENANT_ID, stampDefaultTenant } from './tenants.js';

const SALT_ROUNDS = 12;

/**
 * Guarantee a System Administrator exists.
 *
 * Idempotent and safe to call on every boot: it only acts when the roles table
 * has no user holding `system_admin`. The account it creates is deliberately
 * flagged `is_first_login = 1, password_changed = 0` so the console forces a
 * rotation before anything else can be touched.
 *
 * @returns {{email:string, created:boolean}|null}
 */
export function ensureBootstrapAdmin(db) {
  const existing = db
    .prepare(
      `SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = ? LIMIT 1`,
    )
    .get(ROLE_KEYS.SYSTEM_ADMIN);

  if (existing) return { email: existing.email, created: false };

  const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(ROLE_KEYS.SYSTEM_ADMIN);
  if (!role) return null;

  const { email, password, name } = config.bootstrap;
  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  db.prepare(
    `INSERT INTO users
       (email, full_name, password_hash, job_title, department, role_id, status,
        tenant_id, is_first_login, password_changed, force_password_reset, permissions_mode)
     VALUES (?, ?, ?, 'System Administrator', 'Administration', ?, 'active', ?, 1, 0, 0, 'INHERIT')
     ON CONFLICT(email) DO NOTHING`,
  ).run(email, name, passwordHash, role.id, DEFAULT_TENANT_ID);

  db.prepare("INSERT OR REPLACE INTO system_meta (key, value, updated_at) VALUES ('initialised_at', datetime('now'), datetime('now'))").run();

  return { email, created: true };
}

/**
 * Ensure a Level 200 Platform Super Administrator exists when (and only when)
 * `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` are configured.
 *
 * Idempotent and safe on every boot: it acts only if no `super_admin` account
 * exists yet. The account is flagged for a forced first-login rotation, exactly
 * like the bootstrap administrator, so the environment credential is never the
 * long-term one.
 *
 * @returns {{email:string, created:boolean}|null} null when not configured.
 */
export function ensureSuperAdmin(db) {
  const { email, password, name } = config.superAdmin;
  if (!email || !password) return null;

  const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(ROLE_KEYS.SUPER_ADMIN);
  if (!role) return null;

  const existing = db
    .prepare('SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = ? LIMIT 1')
    .get(ROLE_KEYS.SUPER_ADMIN);
  if (existing) return { email: existing.email, created: false };

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  db.prepare(
    `INSERT INTO users
       (email, full_name, password_hash, job_title, department, role_id, status,
        is_first_login, password_changed, force_password_reset, permissions_mode)
     VALUES (?, ?, ?, 'Platform Super Administrator', 'Platform', ?, 'active', 1, 0, 0, 'INHERIT')
     ON CONFLICT(email) DO NOTHING`,
  ).run(email, name, passwordHash, role.id);

  return { email, created: true };
}

/** Insert the default settings rows if they are missing. */
export function seedSettings(db) {
  const rows = [
    ['institution_name', 'Itahari International College', 'general', 'Institution name', 'string'],
    ['academic_year', '2024/25', 'general', 'Academic year', 'string'],
    ['timezone', 'Asia/Kathmandu', 'general', 'Timezone', 'string'],
    ['capacity_warning_pct', '85', 'operations', 'Capacity warning threshold (%)', 'number'],
    ['alert_retention_days', '90', 'security', 'Alert retention (days)', 'number'],
    ['allow_self_service_rfid', 'false', 'operations', 'Allow self-service RFID issuance', 'boolean'],
    ['maintenance_mode', 'false', 'operations', 'Maintenance mode', 'boolean'],
    ['maintenance_message', 'Server is currently under maintenance. Please try again later.', 'operations', 'Maintenance message', 'string'],
  ];

  const insert = db.prepare(
    `INSERT INTO settings (key, value, group_name, label, value_type)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
  );
  db.transaction(() => {
    for (const row of rows) insert.run(...row);
  });

  db.prepare("INSERT OR REPLACE INTO system_meta (key, value, updated_at) VALUES ('institution_name', ?, datetime('now'))")
    .run(rows[0][1]);
}

// ---------------------------------------------------------------------------
// Demo dataset
// ---------------------------------------------------------------------------
const FIRST = ['Aarav', 'Sanya', 'Rohan', 'Ishita', 'Niraj', 'Pratiksha', 'Bibek', 'Anisha', 'Sudip', 'Manisha',
  'Krishal', 'Aayusha', 'Bipin', 'Chandra', 'Deepak', 'Eesha', 'Gaurav', 'Himal', 'Ilam', 'Janaki',
  'Kiran', 'Laxmi', 'Madan', 'Nisha', 'Omkar', 'Pooja', 'Rajan', 'Sabina', 'Tenzin', 'Ujjwal'];
const LAST = ['Sharma', 'Adhikari', 'Thapa', 'Maharjan', 'Karki', 'Basnet', 'Chhetri', 'Gurung', 'Shrestha',
  'Tamang', 'Lama', 'Rai', 'Limbu', 'Magar', 'Dangal', 'Poudel'];
const FACULTY = ['Computer Engineering', 'Civil Engineering', 'Business Administration', 'Microbiology',
  'Architecture', 'Electrical Engineering', 'Applied Science', 'Management'];

const ROUTES = [
  { code: 'R-01', name: 'Koteshwor – Ring Road Loop', start: 'Koteshwor', end: 'Ring Road', shift: 'MORNING', dep: '06:45', arr: '08:30', color: '#38BDF8', stops: ['Koteshwor Chausala', 'Kalimati', 'Patan Dhoka', 'Ring Road Gate'] },
  { code: 'R-02', name: 'Thamel – Lazimpat Circular', start: 'Thamel', end: 'Lazimpat', shift: 'MORNING', dep: '07:05', arr: '08:15', color: '#A78BFA', stops: ['Thamel Chowk', 'Kantipath', 'Lazimpat Circle', 'Model Hospital'] },
  { code: 'R-03', name: 'Baneshwor – Imadole Express', start: 'Baneshwor', end: 'Imadole', shift: 'BOTH', dep: '07:20', arr: '08:45', color: '#34D399', stops: ['Baneshwor Bypass', 'Tinkune', 'Imadole Junction', 'Sunrise Apartments'] },
  { code: 'R-04', name: 'Balaju – Boudha Shuttle', start: 'Balaju', end: 'Boudha', shift: 'EVENING', dep: '15:30', arr: '17:00', color: '#FBBF24', stops: ['Balaju Chowk', 'Nagarjun', 'Koteshwor', 'Boudha Stupa'] },
];

const BUSES = [
  { code: 'TS-01', reg: 'Ba 2 Kha 7781', name: 'Shivalik', model: 'Tata Starbus EV', capacity: 42, route: 'R-01', driver: 'Ramesh Gurung', phone: '+977 98XXXXXXXX' },
  { code: 'TS-02', reg: 'Ba 5 Kha 3390', name: 'Himalayan', model: 'Tata Starbus', capacity: 38, route: 'R-02', driver: 'Sita Tamang', phone: '+977 98XXXXXXXX' },
  { code: 'TS-03', reg: 'Ga 1 Kha 2204', name: 'Annapurna', model: 'Ashok Leyland Viking', capacity: 45, route: 'R-03', driver: 'Bishal Rai', phone: '+977 98XXXXXXXX' },
  { code: 'TS-04', reg: 'Ba 2 Ga 5518', name: 'Machhapuchhre', model: 'Tata Starbus EV', capacity: 32, route: 'R-04', driver: 'Nirmala Shrestha', phone: '+977 98XXXXXXXX' },
  { code: 'TS-05', reg: 'Ba 1 Pa 9042', name: 'Everest', model: 'Force Motors Traveller', capacity: 26, route: null, driver: 'Deepak Lama', phone: '+977 98XXXXXXXX', status: 'MAINTENANCE' },
];

const DRIVERS = ['Ramesh Gurung', 'Sita Tamang', 'Bishal Rai', 'Nirmala Shrestha', 'Deepak Lama', 'Anita Magar'];

function pick(list, index) {
  return list[index % list.length];
}

function randomSerial(index) {
  return `TS-${(100000 + index * 137).toString(36).toUpperCase().padStart(6, '0')}`;
}

/** Deterministic-ish PRNG so repeated seeds look the same. */
function makeRandom(seed = 20240915) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export function seedDemo(db) {
  const random = makeRandom();

  db.transaction(() => {
    // ---- routes + stops --------------------------------------------------
    const insertRoute = db.prepare(
      `INSERT INTO routes (code, name, start_point, end_point, shift, departure_time, arrival_time, color, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertStop = db.prepare(
      'INSERT INTO route_stops (route_id, sequence, name, scheduled_time, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)',
    );

    const routeIds = {};
    ROUTES.forEach((route, routeIndex) => {
      const result = insertRoute.run(
        route.code,
        route.name,
        route.start,
        route.end,
        route.shift,
        route.dep,
        route.arr,
        route.color,
        `${route.start} to ${route.end} ${route.shift.toLowerCase()} service.`,
      );
      const routeId = Number(result.lastInsertRowid);
      routeIds[route.code] = routeId;

      const baseMinutes = Number(route.dep.slice(0, 2)) * 60 + Number(route.dep.slice(3));
      route.stops.forEach((name, stopIndex) => {
        const minutes = baseMinutes + stopIndex * 18;
        insertStop.run(
          routeId,
          stopIndex + 1,
          name,
          `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
          27.6 + random() * 0.12,
          85.2 + random() * 0.12,
        );
      });
    });

    // ---- buses ------------------------------------------------------------
    const insertBus = db.prepare(
      `INSERT INTO buses (code, registration_no, name, make_model, seat_capacity,
                          driver_name, driver_phone, driver_license, status,
                          current_route_id, odometer_km, last_service_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const busIds = BUSES.map((bus, index) => {
      const result = insertBus.run(
        bus.code,
        bus.reg,
        bus.name,
        bus.model,
        bus.capacity,
        bus.driver,
        bus.phone,
        `LIC-${2020 + (index % 4)}-${1000 + index}`,
        bus.status ?? 'ACTIVE',
        bus.route ? routeIds[bus.route] : null,
        18000 + Math.floor(random() * 90000),
        `2025-0${1 + (index % 9)}-${String(1 + (index % 27)).padStart(2, '0')}`,
      );
      return { ...bus, id: Number(result.lastInsertRowid), capacity: bus.capacity, status: bus.status ?? 'ACTIVE' };
    });

    // ---- students ---------------------------------------------------------
    const insertStudent = db.prepare(
      `INSERT INTO students (full_name, college_id, email, phone, faculty, program, semester,
                             rfid_serial, rfid_status, card_status, card_issued_at,
                             card_revoked_at, card_revoked_reason, status, tenant_id, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    );

    const studentIds = [];
    const today = new Date();
    const activeBuses = busIds.filter((bus) => bus.status === 'ACTIVE');

    for (let index = 0; index < 68; index += 1) {
      const first = pick(FIRST, index);
      const last = pick(LAST, Math.floor(index / FIRST.length));
      const name = `${first} ${last}`;
      const faculty = pick(FACULTY, index);
      const collegeId = `KMI${String(2024000 + index).slice(-7)}`;
      const serial = randomSerial(index);

      const roll = random();
      let status = 'ACTIVE';
      let rfidStatus = 'ACTIVE';

      if (roll > 0.96) status = 'SUSPENDED';
      else if (roll > 0.93) rfidStatus = 'BLOCKED';
      else if (roll > 0.90) rfidStatus = 'LOST';

      const cardStatus = rfidStatus === 'BLOCKED' || rfidStatus === 'LOST' ? 'REVOKED' : 'ACTIVE';
      const issuedAt = new Date(today.getTime() - (30 + index) * 86400000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');

      const result = insertStudent.run(
        name,
        collegeId,
        `${first.toLowerCase()}.${last.toLowerCase()}${index}@kmi.edu.np`,
        `+977 98${String(10000000 + index * 7919).slice(0, 8)}`,
        faculty,
        faculty === 'Business Administration' ? 'BBS' : 'BE',
        1 + (index % 8),
        serial,
        rfidStatus,
        cardStatus,
        issuedAt,
        null,
        null,
        status,
        null,
      );
      studentIds.push({ id: Number(result.lastInsertRowid), serial, name, status, cardStatus });
    }

    // ---- guaranteed edge cases -------------------------------------------
    // The random pass above is a nice spread, but it cannot be relied on to
    // produce the exact records the simulator and the dashboard need: with this
    // seed it happened to yield *zero* BLOCKED cards and zero live occupancy.
    // Force one of each so every outcome is demonstrable out of the box.
    const edgeCases = [
      { pick: 5, patch: { card_status: 'REVOKED', rfid_status: 'BLOCKED' }, why: 'revoked card' },
      { pick: 7, patch: { card_status: 'REVOKED', rfid_status: 'LOST' }, why: 'lost card' },
      { pick: 13, patch: { status: 'SUSPENDED' }, why: 'suspended student' },
    ];

    for (const { pick, patch, why } of edgeCases) {
      const student = studentIds[pick];
      if (!student) continue;
      const assignments = Object.keys(patch).map((column) => `${column} = ?`).join(', ');
      db.prepare(`UPDATE students SET ${assignments} WHERE id = ?`).run(
        ...Object.values(patch),
        student.id,
      );
    }

    // Put a few students physically on a bus so "occupancy" and "utilisation"
    // are non-zero on the dashboard rather than a flat zero.
    const activeBusStudents = db
      .prepare(
        `SELECT id FROM students
          WHERE status = 'ACTIVE' AND card_status = 'ACTIVE'
          ORDER BY id LIMIT 9`,
      )
      .all();

    for (const [index, student] of activeBusStudents.entries()) {
      if (index % 3 === 2) continue; // leave a third of them waiting at the stop
      const bus = activeBuses[index % activeBuses.length];
      if (bus) {
        db.prepare(
          "UPDATE students SET onboard_bus_id = ?, onboard_at = datetime('now', ?) WHERE id = ?",
        ).run(bus.id, `-${(index % 4) * 7 + 3} minutes`, student.id);
      }
    }

    // ---- staff accounts ---------------------------------------------------
    const staffHash = bcrypt.hashSync('TransitStaff@2024', SALT_ROUNDS);
    const staff = [
      {
        email: 'transport@transitsync.edu.np',
        name: 'Prakash Adhikari',
        role: ROLE_KEYS.TRANSPORT_STAFF,
        title: 'Transport Coordinator',
        dept: 'Transport & Logistics',
      },
      {
        email: 'attendant@transitsync.edu.np',
        name: 'Mina Magar',
        role: ROLE_KEYS.ATTENDANT,
        title: 'Bus Attendant',
        dept: 'Transport & Logistics',
      },
      {
        email: 'duty@transitsync.edu.np',
        name: 'Rajesh Karki',
        role: ROLE_KEYS.ATTENDANT,
        title: 'Duty Attendant',
        dept: 'Transport & Logistics',
      },
    ];

    for (const person of staff) {
      const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(person.role);
      db.prepare(
        `INSERT INTO users (email, full_name, password_hash, job_title, department, role_id,
                            status, is_first_login, password_changed, force_password_reset)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 1, 0)
         ON CONFLICT(email) DO NOTHING`,
      ).run(person.email, person.name, staffHash, person.title, person.dept, role.id);
    }

    // Link the first two buses to staff logins as driver accounts? Drivers are
    // modelled as names, not accounts — keep bus.driver_name as the source of truth.

    // ---- historical scan log + derived alerts -----------------------------
    const insertScan = db.prepare(
      `INSERT INTO scan_events (rfid_serial, student_id, bus_id, route_id, direction, outcome,
                                message, latitude, longitude, gate, occupancy_after, scan_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAlert = db.prepare(
      `INSERT INTO alerts (type, severity, title, message, scan_event_id, student_id, bus_id, route_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Alerts are reserved for cards whose UID is unknown to the registry, so the
    // historical log below deliberately does not raise alerts for registered
    // cards that were rejected for other reasons.

    for (let dayOffset = 13; dayOffset >= 0; dayOffset -= 1) {
      const day = new Date(today.getTime() - dayOffset * 86400000);
      const weekday = day.getDay();
      if (weekday === 0) continue; // no weekend service

      for (const bus of activeBuses) {
        const trips = 3;
        for (let trip = 0; trip < trips; trip += 1) {
          const riders = 8 + Math.floor(random() * (bus.capacity - 12));
          const picked = [...studentIds].sort(() => random() - 0.5).slice(0, riders);
          let occupancy = 0;

          picked.forEach((student, position) => {
            const boardMinutes = 7 * 60 + 15 + trip * 55 + Math.floor(random() * 30);
            const time = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')} ${String(Math.floor(boardMinutes / 60) % 24).padStart(2, '0')}:${String(boardMinutes % 60).padStart(2, '0')}:${String(Math.floor(random() * 60)).padStart(2, '0')}`;
            occupancy += 1;

            insertScan.run(
              student.serial,
              student.id,
              bus.id,
              bus.route ? routeIds[bus.route] : null,
              'BOARD',
              'VALID',
              `${student.name} boarded ${bus.code}.`,
              27.6 + random() * 0.1,
              85.2 + random() * 0.1,
              `${bus.name} gate`,
              occupancy,
              time,
            );

            // Matching alight events for the final third of the run.
            if (position > riders * 0.66) {
              const alightMinutes = boardMinutes + 35 + Math.floor(random() * 15);
              insertScan.run(
                student.serial,
                student.id,
                bus.id,
                bus.route ? routeIds[bus.route] : null,
                'DEBOARD',
                'VALID',
                `${student.name} tapped off ${bus.code}.`,
                27.6 + random() * 0.1,
                85.2 + random() * 0.1,
                `${bus.name} gate`,
                Math.max(0, riders - position),
                `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')} ${String(Math.floor(alightMinutes / 60) % 24).padStart(2, '0')}:${String(alightMinutes % 60).padStart(2, '0')}:${String(Math.floor(random() * 60)).padStart(2, '0')}`,
              );
            }
          });
        }
      }
    }

    // A few genuine unregistered-device probes.
    for (let index = 0; index < 4; index += 1) {
      const time = new Date(today.getTime() - Math.floor(random() * 4) * 86400000 - Math.floor(random() * 20) * 3600000);
      const stamp = time.toISOString().slice(0, 19).replace('T', ' ');
      const bus = pick(activeBuses, index);
      const serial = `TS-GHOST${String(1000 + index)}`;
      const scanId = insertScan.run(
        serial, null, bus.id, bus.route ? routeIds[bus.route] : null, 'BOARD', 'UNREGISTERED_CARD',
        `RFID serial ${serial} is not registered to any student.`,
        27.6 + random() * 0.1, 85.2 + random() * 0.1, `${bus.name} gate`, null, stamp,
      ).lastInsertRowid;
      insertAlert.run(
        'UNREGISTERED_DEVICE', 'CRITICAL', 'Unregistered device detected',
        `RFID serial ${serial} presented at ${bus.code}.`, Number(scanId), null, bus.id,
        bus.route ? routeIds[bus.route] : null, 'OPEN', stamp,
      );
    }

    db.prepare(
      "INSERT OR REPLACE INTO system_meta (key, value, updated_at) VALUES ('demo_seeded_at', datetime('now'), datetime('now'))",
    ).run();

    // Attach every seeded row to the default campus so a fresh install is a
    // coherent single-tenant dataset (the migration only backfills pre-existing
    // rows, and seeding runs after it).
    stampDefaultTenant(db);
  });

  return {
    routes: db.prepare('SELECT COUNT(*) AS n FROM routes').get().n,
    buses: db.prepare('SELECT COUNT(*) AS n FROM buses').get().n,
    students: db.prepare('SELECT COUNT(*) AS n FROM students').get().n,
    scans: db.prepare('SELECT COUNT(*) AS n FROM scan_events').get().n,
    alerts: db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n,
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const withDemo = process.argv.includes('--demo');
  const log = (message) => process.stdout.write(`${message}\n`);

  log(`\nTransitSync seed -> ${process.env.DB_FILE || config.paths.dbFile}\n`);
  const db = getDb();
  runMigrations(db, { log });
  seedSettings(db);

  const admin = ensureBootstrapAdmin(db);
  if (admin?.created) {
    log(`  Created System Administrator: ${admin.email}`);
    log(`  Password: ${config.bootstrap.password}   (forced change on first sign-in)\n`);
  } else if (admin) {
    log(`  System Administrator already present: ${admin.email}\n`);
  }

  if (withDemo) {
    const already = db.prepare("SELECT value FROM system_meta WHERE key = 'demo_seeded_at'").get();
    if (already) {
      log('  Demo dataset already present — skipping. Use `npm run reset` for a clean rebuild.\n');
    } else {
      log('  Generating demo dataset ...');
      const counts = seedDemo(db);
      log(`    routes ${counts.routes} · buses ${counts.buses} · students ${counts.students}`);
      log(`    scans ${counts.scans} · alerts ${counts.alerts} · users ${counts.users}`);
      log('\n  Demo staff logins (password: TransitStaff@2024):');
      log('    transport@transitsync.edu.np   Resource & Transport Staff');
      log('    attendant@transitsync.edu.np   Bus Attendant (read-only)\n');
    }
  }

  closeDb();
}
