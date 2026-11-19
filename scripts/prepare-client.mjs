#!/usr/bin/env node
/**
 * Prepare the web console before the launcher hands the browser to it.
 *
 * This runs as the "web console build" preflight step in both
 * `start-transitsync.bat` and `start-transitsync-console.bat`, so the site the
 * browser is about to open always reflects the files currently on disk:
 *
 *   1. Sync the brand icon. `assets/busicon.png` is the master artwork and
 *      `client/public/busicon.png` is the copy Vite actually serves (it is
 *      copied verbatim into `dist/`). Re-copying it on every boot means a
 *      replaced icon always reaches the live site.
 *   2. Rebuild `client/dist` when it is missing, when its dependencies are not
 *      installed, or when any client source file is newer than the built
 *      `dist/index.html`. That is what makes an edit show up before the site
 *      loads instead of silently serving a stale bundle.
 *
 * The caller prints the numbered "[n/N] ... " label; this script prints a single
 * status line for it and exits non-zero when the build fails.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(root, 'client');
const publicDir = path.join(clientDir, 'public');
const distDir = path.join(clientDir, 'dist');
const distIndex = path.join(distDir, 'index.html');
const masterIcon = path.join(root, 'assets', 'busicon.png');
const publicIcon = path.join(publicDir, 'busicon.png');

/** Read a file, or null when it does not exist / cannot be read. */
function read(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// --- 1. brand icon ---------------------------------------------------------
let iconSynced = false;
const master = read(masterIcon);
if (master) {
  const served = read(publicIcon);
  if (!served || !master.equals(served)) {
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(publicIcon, master);
    iconSynced = true;
  }
}

// --- 2. is the build stale? ------------------------------------------------
/** Newest mtime under `target` (recursive; skips node_modules). */
function newestMtime(target, state = { ms: 0 }) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return state;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      if (name === 'node_modules') continue;
      newestMtime(path.join(target, name), state);
    }
  } else if (stat.mtimeMs > state.ms) {
    state.ms = stat.mtimeMs;
  }
  return state;
}

// Everything that can change what `vite build` emits.
const sourcePaths = [
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.js',
  '.env',
  '.env.production',
  '.env.production.local',
  '.env.local',
  'public',
  'src',
];

let newestSource = 0;
for (const rel of sourcePaths) {
  newestSource = Math.max(newestSource, newestMtime(path.join(clientDir, rel)).ms);
}

const distTime = fs.existsSync(distIndex) ? fs.statSync(distIndex).mtimeMs : 0;
const depsMissing = !fs.existsSync(path.join(clientDir, 'node_modules'));
const stale = depsMissing || distTime === 0 || newestSource > distTime;

// --- 3. build --------------------------------------------------------------
if (!stale) {
  process.stdout.write(`OK  (${iconSynced ? 'icon synced, build' : 'build'} up to date)\n`);
  process.exit(0);
}

try {
  if (depsMissing) {
    process.stdout.write('installing client dependencies (first run)...\n');
    execSync('npm install', { cwd: clientDir, stdio: 'inherit' });
  }
  process.stdout.write(
    `building (${iconSynced ? 'brand icon updated' : 'new changes found'}, this can take a minute)...\n`,
  );
  execSync('npm run build', { cwd: clientDir, stdio: 'inherit' });
} catch {
  process.stdout.write('FAILED\n');
  process.exit(1);
}

process.stdout.write('OK  (rebuilt)\n');
