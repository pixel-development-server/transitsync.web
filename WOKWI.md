# Wokwi ⇄ TransitSync bridge

The Wokwi Arduino Uno has no network stack, so it cannot POST to the API by
itself. Instead the firmware prints one JSON object per line over its 9600-baud
serial port, and a small Node relay reads that stream and forwards each line to
`POST /api/scans/sync`. No ESP32 is required.

```
┌──────────────────┐   9600 baud    ┌────────────────────┐   HTTP POST   ┌──────────────────┐
│  Wokwi Uno       │  JSON lines →  │  server/services/  │  ───────────► │  TransitSync API │
│  (MFRC522 + SD)  │                │  wokwi-relay.js    │               │  :8080           │
└──────────────────┘                └────────────────────┘               └────────┬─────────┘
                                                                                  │ processTap()
                                                                                  │ recordVisitorPress()
                                                                                  ▼
                                                                    SQLite + SSE broadcast to the panel
```

## 1. What the firmware prints

One event per line (see `build/sketch.ino`):

```json
{"type":"CARD_TAP","uid":"11 22 33 44","deviceId":"BUS-01"}
{"type":"VISITOR_BUTTON","payload":"CLICK","deviceId":"BUS-01"}
```

- `deviceId` is the reader id. It is matched **case-insensitively** against
  `buses.code`. If nothing matches, the tap still flows through `processTap`
  and lands on the first ACTIVE bus, so a demo never fails outright — but for a
  correct schedule set `DEVICE_ID` in `sketch.ino` to a real bus code (the demo
  seed uses `TS-01` … `TS-05`).
- `uid` may contain spaces; the registry match strips whitespace.
- A `CARD_TAP` runs through the **same** decision engine as the browser
  simulator: registered + active + valid pass + allocated bus ⇒ `VALID` and an
  `APPROVED` attendance row; anything else writes a scan row and raises a
  security alert. `VISITOR_BUTTON` increments the visitor head-count for the
  bus/route and **Nepal calendar day**.
- Timestamps: records are stored in UTC; the console renders Nepal Time
  (Asia/Kathmandu, UTC+5:45).

## 2. Configure the shared token

The relay is a local process with no user session, so it authenticates with a
shared secret instead of JWT. `server/.env` ships with a development value:

```ini
RELAY_TOKEN=transitsync-wokwi-relay-dev-token
# TS_API_URL=http://localhost:8080/api/scans/sync   # optional override
```

The relay reads this file automatically. When `RELAY_TOKEN` is **unset**, the
endpoint accepts loopback requests in development and fails closed in
production — set it for any real deployment.

## 3. Run it (two terminals)

**Terminal 1 — the app** (API on `:8080` + Vite on `:5173`):

```powershell
npm run dev
```

Open http://localhost:5173 and sign in. First run? Complete the wizard at
`/system-setup`, or seed a demo admin with `npm run reset`.

**Terminal 2 — the relay.** Pick the transport that matches how your serial
stream is exposed:

```powershell
# A) stdin — pipe anything that prints the Uno serial to stdout
npm run relay
```

The relay buffers partial reads, ignores boot chatter that isn't JSON, and
reconnects with capped backoff if a socket transport drops.

### Feeding the relay

**Option A — pipe a serial stream into stdin (works everywhere):**

```powershell
# If your Wokwi runner can dump serial to stdout:
npx wokwi-cli . --serial | npm run relay

# Any other producer works too, e.g. a virtual COM pair bridged to stdout.
```

**Option B — WebSocket serial bridge** (e.g. a local serial-to-WS server):

```powershell
$env:WOKWI_SERIAL_WS = "ws://localhost:9000"
npm run relay
```

**Option C — a real serial port** (physical reader or a COM pair); needs the
optional native module once:

```powershell
npm install serialport --prefix server
$env:WOKWI_SERIAL_PORT = "COM3"
npm run relay
```

`WOKWI_SERIAL_BAUD` (default `9600`) and `RELAY_VERBOSE=1` are also honoured.

## 4. Verify

In the panel, open **Live Monitor**. A card tap should appear instantly in the
event stream (over SSE) and, if valid, bump the bus occupancy. A visitor press
appears as a **Visitor head count** row and increments the **Visitors today**
tile. Unregistered cards surface under **Alerts**.

Quick smoke test without a simulator — the relay forwards stdin, so:

```powershell
'{"type":"CARD_TAP","uid":"TS-0025DE","deviceId":"TS-03"}' | npm run relay
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `403 Invalid relay token` | The token in `server/.env` and the one the relay reads (same file) disagree, or another process set `TS_RELAY_TOKEN`. |
| `403 Scan relay is not configured` | No `RELAY_TOKEN` and the request isn't loopback, or `NODE_ENV=production`. Set `RELAY_TOKEN`. |
| `ignored non-JSON line` (with `RELAY_VERBOSE=1`) | Normal — boot banners and `Serial.print` debug lines are skipped. |
| Events forward but map to the wrong bus | `deviceId` doesn't equal any `buses.code`; update `DEVICE_ID` in `build/sketch.ino` or add the bus. |
| `could not reach API` | The server isn't running, or `TS_API_URL`/`PORT` points elsewhere. |
| `serialport` install fails | Use Option A (stdin) or Option B (WebSocket); no native build needed. |

## Files

- `build/sketch.ino` — Uno firmware that emits the JSON lines.
- `server/services/wokwi-relay.js` — the serial → HTTP bridge (`npm run relay`).
- `server/src/routes/scans.routes.js` — `POST /api/scans/sync`, guarded by
  `x-relay-token`, mounted outside the JWT/RBAC chain.
- `server/src/services/scanner.js` — `processTap`, the shared decision engine.
- `server/src/services/visitors.js` — visitor head-count roll-up (`visitor` SSE channel).
