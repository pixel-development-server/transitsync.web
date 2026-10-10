#!/usr/bin/env node
/**
 * Wokwi serial -> TransitSync HTTP relay.
 *
 * The Wokwi Arduino Uno has no network stack, so it cannot POST to the API
 * itself. This tiny bridge reads the Uno's 9600-baud serial output, extracts the
 * JSON event lines the firmware prints, and forwards each one to
 * `POST /api/scans/sync`.
 *
 * Sources, in priority order:
 *   1. WOKWI_SERIAL_WS   — a WebSocket carrying serial text (e.g. ws://localhost:9000)
 *   2. WOKWI_SERIAL_PORT — a real serial device (e.g. COM3); needs `serialport`
 *   3. stdin             — the default, so `npx wokwi-cli ... | npm run relay`
 *                          works with no extra dependencies or native builds.
 *
 * The relay is line-oriented and defensive: partial reads are buffered until a
 * newline, non-JSON boot chatter is ignored, and a dropped transport reconnects
 * with capped exponential backoff instead of exiting.
 */

import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

// Reuse the server's environment so the relay and API always agree on the port,
// the shared token and the ingest URL.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const API_URL =
  process.env.TS_API_URL || `http://localhost:${process.env.PORT || 8080}/api/scans/sync`;
const TOKEN = process.env.TS_RELAY_TOKEN || process.env.RELAY_TOKEN || '';
const SERIAL_WS = process.env.WOKWI_SERIAL_WS || '';
const SERIAL_PORT = process.env.WOKWI_SERIAL_PORT || '';
const BAUD = Number.parseInt(process.env.WOKWI_SERIAL_BAUD || '9600', 10);
const VERBOSE = process.env.RELAY_VERBOSE === '1';

const log = (...args) => console.log('[wokwi-relay]', ...args);
const warn = (...args) => console.warn('[wokwi-relay]', ...args);

// ---------------------------------------------------------------------------
// Line framing
// ---------------------------------------------------------------------------

/**
 * Accumulates raw serial chunks and yields complete lines. Wokwi (and UART in
 * general) fragment output arbitrarily, so a brace-delimited JSON object can
 * arrive split across several reads; only a newline is a safe boundary.
 */
class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = '';
    this.maxBuffer = 64 * 1024; // guard against a never-terminated stream
  }

  push(chunk) {
    this.buffer += chunk.toString('utf8');

    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
    }

    // A line longer than the cap is almost certainly garbage; drop it rather
    // than growing without bound.
    if (this.buffer.length > this.maxBuffer) this.buffer = '';
  }
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

let forwarded = 0;
let dropped = 0;
const inFlight = new Set();

async function forward(event) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers['x-relay-token'] = TOKEN;

  const task = (async () => {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        warn(`API rejected ${event.type}: HTTP ${response.status} ${detail.slice(0, 200)}`);
        dropped += 1;
        return;
      }

      forwarded += 1;
      if (VERBOSE) log(`forwarded ${event.type} -> ${response.status}`);
    } catch (error) {
      // The API may simply be down; keep the reader alive and let the next event retry.
      warn(`could not reach API at ${API_URL}: ${error.message}`);
      dropped += 1;
    }
  })();

  inFlight.add(task);
  try {
    await task;
  } finally {
    inFlight.delete(task);
  }
}

const splitter = new LineSplitter((line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // Boot banners and debug prints from the sketch are not events.
    if (VERBOSE) log(`ignored non-JSON line: ${line.slice(0, 120)}`);
    return;
  }

  if (!event || typeof event !== 'object' || !event.type) {
    if (VERBOSE) log(`ignored JSON without a type: ${line.slice(0, 120)}`);
    return;
  }

  void forward(event);
});

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reconnect loop shared by the socket transports. */
async function withReconnect(label, connect) {
  let attempt = 0;
  let stopping = false;

  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopping) {
    try {
      await connect(() => {
        attempt = 0;
      });
      // connect() resolves only when the transport closes.
    } catch (error) {
      warn(`${label} error: ${error.message}`);
    }

    if (stopping) break;

    attempt += 1;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 15_000);
    warn(`${label} disconnected — retrying in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}

async function runWebSocket() {
  const { default: WebSocket } = await import('ws');

  await withReconnect(`websocket ${SERIAL_WS}`, (onOpen) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(SERIAL_WS);

      socket.on('open', () => {
        onOpen();
        log(`connected to ${SERIAL_WS}`);
      });
      socket.on('message', (data) => splitter.push(data));
      socket.on('close', () => resolve());
      socket.on('error', (error) => {
        reject(error);
        socket.close();
      });
    }),
  );
}

async function runSerialPort() {
  let SerialPort;
  try {
    ({ SerialPort } = await import('serialport'));
  } catch {
    throw new Error(
      'WOKWI_SERIAL_PORT is set but the optional `serialport` package is not installed.\n' +
        '  Install it with:  npm install serialport --prefix server',
    );
  }

  await withReconnect(`serial ${SERIAL_PORT}@${BAUD}`, (onOpen) =>
    new Promise((resolve, reject) => {
      const port = new SerialPort({ path: SERIAL_PORT, baudRate: BAUD });

      port.on('open', () => {
        onOpen();
        log(`connected to ${SERIAL_PORT} @ ${BAUD} baud`);
      });
      port.on('data', (data) => splitter.push(data));
      port.on('close', () => resolve());
      port.on('error', (error) => {
        reject(error);
        port.close();
      });
    }),
  );
}

async function runStdin() {
  log(`reading serial from stdin -> ${API_URL}`);
  log('pipe a Wokwi run into this process, e.g.  npx wokwi-cli . --serial | npm run relay');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => splitter.push(`${line}\n`));
  rl.on('close', async () => {
    // Let any queued forwards finish before we exit, or a short pipe would drop them.
    await Promise.allSettled([...inFlight]);
    log(`stdin closed. forwarded ${forwarded}, dropped ${dropped}.`);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------

async function main() {
  log(`target: ${API_URL} ${TOKEN ? '(token auth)' : '(no token — loopback only)'}`);

  if (SERIAL_WS) return runWebSocket();
  if (SERIAL_PORT) return runSerialPort();
  return runStdin();
}

main().catch((error) => {
  warn(error.message);
  process.exit(1);
});
