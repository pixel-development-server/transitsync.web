# TransitSync — GitHub workflow, primary server and Git-hosted failover

This document is the runbook for a **primary-first, Git-hosted fallback** deployment of
`https://transitsync.me`.

| Build | Where it runs | Google Sign-In | API target |
|---|---|---|---|
| **Primary** (full features) | Self-hosted VPS / homelab server | **Enabled** (`VITE_ENABLE_GOOGLE_AUTH=true`, `ENABLE_GOOGLE_AUTH=true` on the API) | Same origin (`/api`) |
| **Fallback** (Git-hosted) | GitHub Pages, published by CI | **Compiled out** (`VITE_ENABLE_GOOGLE_AUTH=false`) | Same-origin `/api`; the edge returns a clean JSON 503 while the primary is down |

The edge is the only component that decides which build a visitor receives. It can be
Cloudflare Load Balancing (recommended), a small Cloudflare Worker (bundled here), or an
always-on Caddy edge proxy.

```
Browser
   │ HTTPS
   ▼
Cloudflare edge  ── health: GET /api/health (success:true AND database:up)
   │                      │
   │ healthy              │ unhealthy / 5xx / timeout
   ▼                      ▼
Primary server         GitHub Pages fallback
 (Node + MySQL)         (static, Google-free)
   │
   └── Caddy :8080 ──► Node :3100 ──► MySQL
```

---

## 1. Repository hygiene and the first push

`.gitignore` is audited at three levels:

- root `.gitignore` — dependencies, `dist/`, `.env`/`.env.*` (except `.env.example`),
  private keys/certs, local DB files and dumps, `logs/`, `storage/`, `backups/`.
- `client/.gitignore` — client `node_modules`, `dist`, local env files including
  `client/.env.production`.
- `server/.gitignore` — `server/.env` (real JWT/DB/Google secrets), `data/`, dumps, logs.

`git status` must never list `.env`, `server/.env`, `certs/`, `logs/`, `storage/`,
`node_modules/` or `dist/`. Verify with:

```bash
git check-ignore -v server/.env client/.env.production certs/ logs/ node_modules/ client/dist/
```

### Exact push commands

```bash
git status
git add -A
git status                      # re-check: no .env / certs / logs / node_modules / dist
git commit -m "feat: add primary-first failover deploy with Google-free fallback"
git branch -M main

# First push only. This repo already has an origin, so use set-url if it exists:
git remote add origin https://github.com/pixel-development-server/transitsync.web.git
# git remote set-url origin https://github.com/pixel-development-server/transitsync.web.git

git push -u origin main
```

That single commit also removes the old `.github/workflows/pages.yml` (it built the
fallback **with** Google) and adds `.github/workflows/deploy.yml`. Do not leave both
workflows publishing to Pages — they would race and the old one could overwrite the
Google-free bundle.

### How Google Sign-In is excluded from the fallback build

| Layer | Mechanism | Result in fallback |
|---|---|---|
| Client bundle | Vite `define` → `__GOOGLE_AUTH_ENABLED__ = false` in `client/vite.config.js`; `client/src/lib/features.js` folds it to a literal | `GoogleSignInButton.jsx`, `googleDebug.js`, the GIS script, the button and `api.post('/auth/google')` are dead-code-eliminated |
| Client request | `useApi('/auth/google/config', { enabled: false })` (path becomes `null`) | No OAuth config request is made |
| Server routes | `if (config.google.enabled)` around both `/api/auth/google*` routes | Endpoints answer 404 on a Google-free server |
| CSP | Google origins only added when the feature is enabled | No `accounts.google.com` in the fallback's policy |
| CI guard | `grep` over `client/dist` for Google markers | Build fails if any Google code leaks back in |

Local checks (from the repo root):

```bash
rm -rf client/dist
VITE_ENABLE_GOOGLE_AUTH=false npm run build --prefix client
# must print no matches:
grep -RInE 'accounts\.google\.com|Continue with Google|auth/google|google\.accounts\.id' client/dist
```

Build the full primary bundle on the server with
`VITE_ENABLE_GOOGLE_AUTH=true npm run build --prefix client`.

---

## 2. GitHub configuration

### Repository settings

- **Settings → Pages → Build and deployment → Source: GitHub Actions** (the
  `deploy.yml` artifact is the publisher).
- **Settings → Pages → Custom domain:** either remove `transitsync.me` here (let the
  edge own it) or keep it only if Pages remains reachable for health checks. The
  custom-domain marker is written into the artifact by CI.
- Optional: protect `main` (require a PR + passing checks) so a broken bundle cannot
  be published by a direct push.

### Primary deployment: self-hosted Windows runner (no SSH)

The primary is this Windows homelab. A self-hosted GitHub Actions runner registered
to this repository (name `transitsync-homelab`, label `transitsync-primary`) runs the
`deploy-primary` job as a Windows service. No SSH server, inbound ports, or deploy
keys are needed. The repo is public, so `git fetch origin main` works without extra
credentials.

Runner install (already completed on the homelab; repeat on a replacement machine):

```powershell
# Download & expand the latest runner (v2.338.2 at time of writing)
Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-win-x64-2.338.2.zip" -OutFile "$env:TEMP\runner.zip" -UseBasicParsing
Expand-Archive "$env:TEMP\runner.zip" -DestinationPath C:\actions-runner-transitsync -Force
cd C:\actions-runner-transitsync

# Get a short-lived registration token from gh / the GitHub UI, then register
# WITH --runasservice so it installs and starts a Windows service automatically.
$tok = gh api -X POST repos/pixel-development-server/transitsync.web/actions/runners/registration-token --jq .token
.\config.cmd --url https://github.com/pixel-development-server/transitsync.web `
  --token $tok --name transitsync-homelab --labels transitsync-primary `
  --work _work --unattended --replace --runasservice
```

`--runasservice` installs `actions.runner.pixel-development-server-transitsync.web.transitsync-homelab`
as a delayed-auto-start Windows service. It defaults to `NETWORK SERVICE`, but that
account cannot control the SYSTEM-level `TransitSync-Web` scheduled task, so switch
it to `LocalSystem` (full machine rights) immediately after install:

```powershell
sc.exe config "actions.runner.pixel-development-server-transitsync.web.transitsync-homelab" obj= LocalSystem
Restart-Service -Name "actions.runner.pixel-development-server-transitsync.web.transitsync-homelab" -Force
```

`LocalSystem` has FullControl on the checkout directory (`C:\SYP` by default), which
the job needs for `git reset --hard`, `npm ci` and rebuilding `client/dist`.

Verify the runner is online:

```bash
gh api repos/pixel-development-server/transitsync.web/actions/runners \
  --jq '.runners[] | {name,status,busy,labels: [.labels[].name]}'
```

### Required GitHub Secrets / Variables

| Name | Kind | Purpose |
|---|---|---|
| `PRIMARY_DEPLOY_PATH` | variable | Local checkout path for the primary (set to `C:\SYP`; workflow falls back to that value if unset) |
| `CLOUDFLARE_ZONE_ID` | secret | Optional — enables post-deploy cache purge |
| `CLOUDFLARE_API_TOKEN` | secret | Optional — token with `Zone.Cache Purge` permission |

No SSH keys are used. Keep Google credentials **on the primary server only** — the
runner writes a git-ignored `client\.env.production.local` with
`VITE_ENABLE_GOOGLE_AUTH=true`, and the API reads `ENABLE_GOOGLE_AUTH=true` plus
`GOOGLE_CLIENT_ID=...` from the ignored `server/.env`. Never commit them.

### What `.github/workflows/deploy.yml` does on every push to `main`

1. `verify` — `node --check` on server sources and `npm run lint` on the client.
2. `build-fallback` — clean build with `VITE_ENABLE_GOOGLE_AUTH=false`, assert no Google
   markers in `client/dist`, add `CNAME`, upload Pages artifact.
3. `deploy-fallback` — publish that artifact to GitHub Pages.
4. `deploy-primary` — on the self-hosted Windows runner: `git fetch/reset --hard
   origin/main` in `C:\SYP`, write the git-ignored `client\.env.production.local`
   with full-feature flags, `npm ci` for both packages, full client build with Google
   enabled, restart the `TransitSync-Web` scheduled task, then
   `node scripts\verify-deploy.mjs http://127.0.0.1:3100/api/health 120000 --expect-google-route`.
   The gate requires `success:true` **and** `data.database:"up"` **and** the Google route
   mounted. Finally, if Cloudflare secrets exist, purge the edge cache.

---

## 3. Primary server setup (Windows homelab)

The primary is already running on this machine: the `TransitSync-Web` scheduled task
starts the API, Caddy and the Cloudflare tunnel; the API binds `127.0.0.1:3100`, Caddy
serves `client/dist` and proxies `/api/*` to `:3100` on `127.0.0.1:8080`, and the
tunnel publishes `transitsync.me` (no inbound ports). The GitHub Actions runner
installed in section 2 deploys new commits locally — no SSH, PM2 or systemd involved.

Key local pieces:

- Checkout: `C:\SYP` (override with `PRIMARY_DEPLOY_PATH` if moved).
- Service: `TransitSync-Web` scheduled task. Restart it with:
  ```powershell
  Stop-ScheduledTask -TaskName TransitSync-Web -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Start-ScheduledTask -TaskName TransitSync-Web
  ```
- Secrets: `server/.env` (git-ignored) holds `DB_*`, `JWT_SECRET`, SMTP settings,
  `ENABLE_GOOGLE_AUTH=true` and `GOOGLE_CLIENT_ID=...`. The runner writes the
  client-side build flag into git-ignored `client\.env.production.local`. `dotenv`
  loads with `override:false`, so real environment variables still win, and
  `server/src/index.js` runs migrations on boot so a restart applies schema changes.
- Health gate: `node scripts\verify-deploy.mjs http://127.0.0.1:3100/api/health
  120000 --expect-google-route` must exit 0 before the job is green.
- Runner service runs as `LocalSystem` (see section 2) so it can control the
  `TransitSync-Web` task and write to `C:\SYP`. It auto-starts (delayed) on boot.

The bundled `deploy/systemd/transitsync.service` and `deploy/caddy/Caddyfile.primary`
are provided for a Linux fallback host, but are not used by the Windows primary.
Origin Caddy config for this machine is the root `Caddyfile` (listens on
`127.0.0.1:8080`, proxies `/api/*` and `/socket.io/*` to `:3100`, serves `client/dist`,
sends `no-store` for the SPA shell and immutable caching for fingerprinted assets).

---

## 4. Edge failover configuration

### Option A — Cloudflare Load Balancer (recommended)

1. **DNS**
   | Type | Name | Value | Proxy |
   |---|---|---|---|
   | A / AAAA or CNAME | `origin.transitsync.me` | primary server public IP | DNS only (grey) |
   | CNAME | `transitsync.me` | load balancer hostname (CNAME flattening handles apex) | Proxied |
   | CNAME | `www` | `transitsync.me` | Proxied |
   | A | `api.transitsync.me` | primary server IP | Proxied |

   `origin.transitsync.me` must **not** be proxied through the same edge rule, or the
   health probe can loop. Remove old apex records pointing at GitHub Pages IPs.

2. **Health monitor** (Traffic → Load Balancing → Monitors)
   - Path `/api/health`, port 443, HTTPS, expected status `200`.
   - Interval 30s, timeout 5s, up threshold 2, down threshold 2.
   - A response with `database:"down"` still has HTTP 200 only if `success:true` —
     the health handler sets `success` from the DB check, so add a JSON body check for
     `"success":true` if your plan supports it. Otherwise use the Worker (below),
     which checks both fields.

3. **Pools**
   - `transitsync-primary`: origin `origin.transitsync.me:443`, attach the monitor.
   - `transitsync-fallback`: origin `pixel-development-server.github.io:443`, path
     `/transitsync.web/`, expected 200. Because Pages uses a project subpath, prefer
     the Worker in Option B (it preserves the prefix); a Load Balancer needs a
     root-served custom domain for clean asset URLs.

4. **Load balancer** for `transitsync.me`
   - Default/primary pool: `transitsync-primary`.
   - Fallback pool: `transitsync-fallback`.
   - Session affinity: **None** (sticky sessions would keep users on a stale fallback).
   - TTL: 30s. "Steady state" off. Proxy mode on.
   - Region/geo steering off so one global primary is used everywhere.

Result: while the primary answers healthy, **100%** of traffic (including new deploys)
goes to it; the Pages bundle is unreachable at `transitsync.me`. It is used only after
the monitor marks the primary down, and traffic returns automatically when it recovers.

Cloudflare Load Balancing is a paid add-on. If it is not available, use Option B.

### Option B — Cloudflare Worker (no paid add-on)

`deploy/cloudflare/failover-worker.js` implements the same policy with a cached 15s
health probe. It checks `success:true` and `data.database:"up"`, proxies healthy traffic
to the primary, serves Pages only when unhealthy, and returns `503 PRIMARY_OFFLINE`
for `/api/*` and `/socket.io/*` while in fallback.

```bash
cd deploy/cloudflare
cp wrangler.toml.example wrangler.toml   # set PRIMARY_ORIGIN / FALLBACK_ORIGIN
npx wrangler deploy
npx wrangler route put "transitsync.me/*" transitsync-edge
```

Check the current decision at any time:

```bash
curl -s https://transitsync.me/__edge/health
# {"mode":"primary","primary":"up",...}  or  {"mode":"fallback","primary":"down",...}
```

Each response carries `X-TransitSync-Mode: primary|fallback`, which makes the
verification checklist below deterministic. The Worker forwards the public
hostname in `X-Forwarded-Host`; `server/src/app.js` accepts that as a self origin,
so same-origin auth POSTs still pass the CORS check. (As a belt-and-braces
measure, `CORS_ORIGINS=https://transitsync.me` may also be set in the primary
server's environment.)

### Option C — DNS-only failover (last resort)

Set apex TTL to 60s and swap the A record from the VPS IP to GitHub Pages
(`185.199.108.153`, `.109`, `.110`, `.111`) with the Cloudflare API when
`https://origin.transitsync.me/api/health` fails, and swap back when it recovers.
DNS failover is slower and older caches may keep visitors on the fallback longer;
prefer A or B.

### Why stale Git-hosted assets cannot override live updates

- Routing is health-based, not weight-based: a healthy primary receives all traffic.
- The fallback artifact has **different content hashes** than the primary build
  (Google code removed), so a cached `index.html` can never request a primary asset
  from the fallback host, or vice versa.
- `index.html` and all JSON are `Cache-Control: no-store`; only hashed assets are
  `immutable` (Caddy config + Worker). The app registers **no Service Worker**, so
  there is no worker cache to invalidate.
- CI purges the Cloudflare cache after each successful primary deploy.

---

## 5. Post-deploy verification checklist

### A. Git-hosted / fallback site is clean

- [ ] Open `https://pixel-development-server.github.io/transitsync.web/` (or force
      fallback by stopping the primary): the login card shows **no** "Continue with
      Google" button or divider.
- [ ] Search the page source/bundle: no `accounts.google.com`, `google.accounts.id`,
      `/auth/google` or `Continue with Google`.
- [ ] `curl -i https://transitsync.me/api/auth/google/config` while in fallback returns
      a non-200 error (`503 PRIMARY_OFFLINE` with the Worker, `502` with Load Balancing,
      `404` on Pages directly), never a working OAuth config.
- [ ] CI step **Assert no Google Sign-In in fallback bundle** is green on every run.

### B. Primary online → latest feature served globally

- [ ] Workflow run: `deploy-primary` succeeded (git reset, build, restart, health gate).
- [ ] `curl -s https://transitsync.me/api/health` → `success:true`, `database:"up"`,
      new `version`/feature present.
- [ ] `curl -I https://transitsync.me/` → `X-TransitSync-Mode: primary`.
- [ ] A brand-new/incognito browser session loads the newest hashed asset names and
      the new feature works; email/password sign-in and Google Sign-In both work.

### C. Primary offline → fallback, no broken endpoints

- [ ] Stop it:
      `Stop-ScheduledTask -TaskName TransitSync-Web; Start-Sleep -Seconds 3`
      (or use `scripts\stop-web-service.ps1`).
- [ ] Wait for two failed health checks (~30–60s depending on monitor settings).
- [ ] `curl -I https://transitsync.me/` → `X-TransitSync-Mode: fallback`; full UI renders.
- [ ] No Google sign-in option anywhere; `/api/*` returns the explicit `503
      PRIMARY_OFFLINE` JSON rather than a Pages 200/HTML error.
- [ ] Browser console shows no Google SDK load attempt and no unhandled OAuth error.

### D. Primary restarted → traffic returns, nothing stale

- [ ] `Start-ScheduledTask -TaskName TransitSync-Web`, then
      `node scripts\verify-deploy.mjs http://127.0.0.1:3100/api/health 120000 --expect-google-route`
      exits 0.
- [ ] `curl -s https://transitsync.me/__edge/health` → `"mode":"primary"`.
- [ ] Hard-refresh once (Ctrl/Cmd+Shift+R). DevTools → Application → Service Workers
      shows none registered; `index.html` response header is `no-store`.
- [ ] The newest feature and the "Continue with Google" option are back on the
      primary, with no mixed old/new asset errors.
- [ ] Re-run the whole checklist after the next push to `main`.

### Rollback

- **Bad primary build:** re-run the previous successful workflow
  (`Actions → Deploy TransitSync → Run workflow` on the previous commit) or on the
  server `git reset --hard <good-sha>` and restart. The edge keeps serving the
  fallback until `/api/health` is green again, then returns to the repaired primary.
- **Bad fallback build:** revert the offending commit; the CI Pages job republishes
  the last known-good Google-free artifact. Primary traffic is unaffected.
- **Edge misconfiguration:** point `transitsync.me` directly at the primary origin
  temporarily; the fallback remains available at its GitHub Pages URL.
