# TransitSync

RFID campus shuttle operations console — a React panel, a Node/Express API with
MariaDB (XAMPP), role-based access control, and live Server-Sent Events.

```
SYP/
├── client/   React + Vite panel (REST + SSE)
├── server/   Node/Express API, MariaDB (XAMPP), RBAC, SSE hub
├── scripts/  launchers, IIS provisioning, server helpers
├── assets/   branding (icon etc.)
└── .github/  GitHub Actions deploy workflow (Pages fallback + self-hosted runner)
```

## Architecture (primary-first with Git-hosted failover)

- **Primary:** the self-hosted server serves the full React panel and the
  Node/Express API from one origin at `https://transitsync.me` (Caddy → Node on
  `:3100` → MySQL). This build includes the latest features and Google Sign-In.
- **Fallback:** GitHub Pages publishes a **Google-free** static bundle
  (`VITE_ENABLE_GOOGLE_AUTH=false`). It is only served when the primary fails its
  `/api/health` check; when the primary recovers, traffic returns to it automatically.
- **Edge:** Cloudflare Load Balancing, the bundled Worker (`deploy/cloudflare/`), or
  an always-on Caddy edge proxy performs the health-checked failover.
- **Database:** MySQL/MariaDB; schema in `server/sql/schema.sql`, migrations run on API boot.

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for the full runbook: repository
hygiene, Git push commands, the self-hosted Windows runner, DNS/health-check setup,
the `.github/workflows/deploy.yml` pipeline and the verification checklist.

## Local development

```bash
cd client && npm install && npm run dev      # panel on :5173 (proxies /api)
cd server && npm install && npm start        # API on http://localhost:8080
```

Default build is same-origin (the server also serves `client/dist`), so
`VITE_API_URL` is only needed for the Git-hosted fallback build. Google Sign-In
is opt-in at build time: local/full builds use `VITE_ENABLE_GOOGLE_AUTH=true`;
the fallback uses `false` (the default).

## Running the server (Windows)

The installed `TransitSync-Web` scheduled task runs the API, Caddy and tunnel in
the background. To watch the shared log, double-click **TransitSync Server** (or
run `start-transitsync-console.bat`); in service mode this is a read-only viewer
and closing it does **not** take the site offline. See
`docs/HOMELAB_TUNNEL_RUNBOOK.md` for the Windows specifics.

## Deploying on every push to `main`

`.github/workflows/deploy.yml` builds and publishes both targets:

- **Git-hosted fallback → GitHub Pages:** `VITE_ENABLE_GOOGLE_AUTH=false`, with a
  CI assertion that no Google OAuth code reached `client/dist`.
- **Primary server → self-hosted Windows runner:** this homelab runs a GitHub
  Actions runner (`transitsync-homelab`, label `transitsync-primary`) as a Windows
  service. It pulls the same commit into `C:\SYP`, rebuilds with
  `VITE_ENABLE_GOOGLE_AUTH=true`, restarts the `TransitSync-Web` scheduled task,
  then gates on `/api/health` reporting `database: "up"` and the Google route being
  mounted. No SSH server or inbound ports are required.

### DNS (example — Cloudflare)

| Type | Host | Value | Proxy |
|------|------|-------|-------|
| A / CNAME | origin | primary server public IP | DNS only |
| CNAME | @ | load balancer / Worker route for `transitsync.me` | Proxied |
| A | api | primary server public IP | Proxied |

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for the failover pools, health
monitor settings, runner setup, optional Cloudflare secrets, exact Git commands
and the full post-deploy verification checklist.

## Sensitive files

Root, `client/` and `server/` `.gitignore` files exclude `.env`/`.env.*`
(except `.env.example`), `certs/`, private keys, `logs/`, `storage/`, local DB
files and dumps, `node_modules/` and `dist/`. Never commit a real `.env` — it
holds `JWT_SECRET`, the bootstrap admin password, DB credentials and
`GOOGLE_CLIENT_ID` configuration.