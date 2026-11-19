// ---------------------------------------------------------------------------
// TransitSync — PM2 process definition (local homelab production)
//
//   Start : pm2 start ecosystem.config.js
//   Reload: pm2 reload ecosystem.config.js   (zero-downtime for the API)
//   Logs  : pm2 logs transitsync-api
//   Save  : pm2 save     (persist across reboots; also run `pm2 startup`)
//
// The API reads server/.env itself (absolute DB_PATH + secrets live there), so
// the `env` block below only pins the two values Caddy depends on.
//
// WHY A SINGLE FORK PROCESS (not `instances: 'max'` / cluster)
//   The live map is fanned out by an IN-PROCESS singleton (server/src/services/
//   realtime.js -> `hub`). Each cluster worker would own a *separate* client map,
//   so a scan/alert broadcast on worker A is never delivered to an SSE client
//   pinned to worker B — the live monitor and alert feed silently miss events.
//   SQLite also allows a single writer, so N workers contend on one file.
//   One fork process keeps every SSE subscriber and every write in the same
//   process: correct, and comfortably enough for a single campus.
//
//   Revisit `instances: 'max'` + `exec_mode: 'cluster'` ONLY after adding a
//   cross-worker bus (e.g. a Redis pub/sub adapter for the hub).
// ---------------------------------------------------------------------------
module.exports = {
  apps: [
    {
      name: 'transitsync-api',
      script: './server/src/index.js',
      instances: 1,
      exec_mode: 'fork',
      // Resolve the relative script path from the repo root regardless of where
      // `pm2` was invoked.
      cwd: __dirname,
      // The API waits up to 5s to drain lingering SSE sockets on shutdown.
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 3100,
      },
    },
  ],
};
