# TransitSync — Homelab Cutover Runbook (Cloudflare Tunnel)

Cut `transitsync.me` over from the cloud (GitHub Pages + the old `api.` tunnel
origin) to the local homelab box, with **zero cloud dependencies** for the
application itself.

---

## 0. Reality check (verified on this host, 2026-10-15)

| Thing | State |
|---|---|
| `transitsync.me` / `www` | Served by **GitHub Pages**, proxied through Cloudflare (`x-github-request-id`, `via: varnish`). Not Vercel/Cloudflare Pages. |
| `api.transitsync.me` | Cloudflare Tunnel `transitsync` → `http://localhost:8080` → **502** (nothing on 8080). |
| Cloudflare Tunnel | Exists and runs as the Windows service `cloudflared` (Automatic, Running). ID `3ded8397-d740-44a9-8831-43b8a867b268`. |
| Tunnel config | `C:\Users\Administrator\.cloudflared\config.yml` (service runs `cloudflared --config <that file> tunnel run`). |
| CI | `.github/workflows/pages.yml` builds the SPA with `VITE_API_URL=https://api.transitsync.me` and publishes a `CNAME`. |
| Port 80 | Held by **IIS / http.sys** (PID 4). |
| Ports 3000 / 8080 | Free. |
| Caddy | **Not installed.** |
| PM2 | **Not installed.** |
| cloudflared | Installed (`C:\Program Files\cloudflared\cloudflared.exe`). |
| node / npm | Installed. |
| Package managers | No winget / choco / scoop. |

Because a tunnel already exists and the domain is already on Cloudflare, the
correct model is **Cloudflare Tunnel** (edge TLS, tunnel to a loopback HTTP
origin). No ACME, no inbound ports, no port-80 conflict with IIS.

---

## 0. Current live setup (authoritative)

As of 2026-11-18 the site is owned by an **always-on Windows scheduled task**,
not by a desktop window:

| Item | Value |
| --- | --- |
| Service task | `TransitSync-Web` (SYSTEM, session 0, startup + logon, restart-on-failure) |
| Watchdog task | `TransitSync-Web-Watchdog` (every 5 min, restarts the service if the origin is down) |
| Service body | `scripts\run-web-service.ps1` → `scripts\console-supervisor.mjs --service` |
| API | `127.0.0.1:3100` (Express, direct `node`, **PM2 retired**) |
| Origin | `127.0.0.1:8080` (Caddy) |
| Tunnel | cloudflared foreground connector, `protocol: http2`, `edge-ip-version: "4"` |
| Public | `https://transitsync.me` |

Install/repair: `powershell -ExecutionPolicy Bypass -File scripts\install-web-service.ps1`
Stop: `powershell -ExecutionPolicy Bypass -File scripts\stop-web-service.ps1`

Running `start-transitsync-console.bat` while the service stamp
(`logs\transitsync-service.active`) exists opens a **viewer** that only tails the
shared log; closing it does **not** take the site offline. Only when that stamp
is absent does the window become the owner (legacy fallback). The old
`TransitSync-Caddy` / `TransitSync-PM2` tasks stay **Disabled**.

---

## 1. Target architecture

```
Browser ──HTTPS──► Cloudflare edge (TLS terminates, valid cert)
                        │
                        │  outbound-only tunnel (no open ports)
                        ▼
                  cloudflared (service)
                        │  http://127.0.0.1:8080
                        ▼
                     Caddy :8080 (Caddyfile)
                        ├── /api/*, /socket.io/* ─► Express API :3100
                        └── everything else ──────► C:\SYP\client\dist (SPA)
```

- One public origin: `https://transitsync.me`. The SPA and the API share it
  (`VITE_API_URL=/api`), so cookies and SSE stay first-party.
- `api.transitsync.me` is retained only for compatibility.

Files used by this runbook:

- `Caddyfile` — tunnel-mode origin (HTTP on `127.0.0.1:8080`).
- `Caddyfile.direct` — alternative: public `:443` + automatic HTTPS (A record +
  port-forward, no tunnel). Kept for reference.
- `scripts\install-web-service.ps1` — installs the active `TransitSync-Web`
  service (Express API on port 3100). `ecosystem.config.js` is legacy; PM2 is retired.
- `deploy.bat` — build frontend, install backend deps, reload PM2, start/reload
  Caddy.
- `%USERPROFILE%\.cloudflared\config.yml` — tunnel ingress.

---

## 2. Phase A — Disconnect the cloud

Nothing here deletes code. GitHub Pages is a *publishing target*; disabling it
leaves every commit/branch intact.

### A1. Stop the Pages deploy (optional but recommended)

Repo → **Settings → Pages → Build and deployment → Source = None**. This keeps
`pages.yml` and all code, it just stops publishing. (Alternatively edit
`.github/workflows/pages.yml` so `on:` is `workflow_dispatch:` only.) Leaving it
on is harmless once the custom domain is removed, but it will keep publishing to
`https://<org>.github.io/transitsync.web/`.

### A2. Release the custom domain from GitHub Pages

Repo → **Settings → Pages → Custom domain** → delete `transitsync.me` → Save.
This is what "unbinds" the apex from GitHub Pages. Do the same for `www` if it
was listed.

> If a **Vercel** or **Cloudflare Pages** project also has `transitsync.me`
> attached, remove it there too (Project → Settings → Domains). Neither is
> currently serving the apex, but Cloudflare will refuse/override a conflicting
> record if one exists.

### A3. Free the DNS records in Cloudflare

Cloudflare dashboard → **DNS → Records**. Delete the existing apex/www records
that point at GitHub Pages (typically `CNAME transitsync.me → <org>.github.io`
flattened to A records, or `AAAA`). You will recreate them as tunnel records in
Phase C. Leave `api.transitsync.me` alone; it is updated in place.

Check TLS mode: **SSL/TLS → Overview → Encryption mode = Full** (Cloudflare ↔
your origin). With a tunnel the edge↔connector leg is already secure; `Full` is
the correct setting. Do **not** use Flexible.

---

## 3. Phase B — Local services

### B1. Install PM2 (npm, no package manager needed)

```bat
npm install -g pm2
pm2 --version
```

### B2. Install Caddy (manual — no winget/choco/scoop on this host)

1. Download `caddy_windows_amd64.exe` from the Caddy releases page
   (`https://github.com/caddyserver/caddy/releases`).
2. Create `C:\Caddy\` and save it there as `caddy.exe`.
3. Add `C:\Caddy` to the machine **PATH** (System Properties → Environment
   Variables), then open a new shell and run:

```bat
caddy version
```

> Optional: register Caddy as a service with NSSM or `sc.exe` so it survives
> reboots. `caddy start` (used by `deploy.bat`) does **not** survive a reboot on
> its own.

### B3. Deploy

```bat
cd /d C:\SYP
deploy.bat
```

This builds `client\dist`, installs backend deps, reloads/starts the PM2 app
`transitsync-api` on port 3000, and starts/reloads Caddy on `127.0.0.1:8080`.

Validate the Caddy config first if you like:

```bat
cd /d C:\SYP
caddy validate --config Caddyfile
```

Check what is running:

```bat
pm2 status
curl http://127.0.0.1:8080/api/health
```

---

## 4. Phase C — Point the tunnel + DNS at the homelab

### C1. Ingress (already written to `%USERPROFILE%\.cloudflared\config.yml`)

```yaml
tunnel: 3ded8397-d740-44a9-8831-43b8a867b268
credentials-file: C:/Users/Administrator/.cloudflared/3ded8397-d740-44a9-8831-43b8a867b268.json
ingress:
  - hostname: transitsync.me
    service: http://127.0.0.1:8080
  - hostname: www.transitsync.me
    service: http://127.0.0.1:8080
  - hostname: api.transitsync.me
    service: http://127.0.0.1:8080
  - service: http_status:404
```

### C2. Create the tunnel DNS records

Either let cloudflared create them:

```bat
cloudflared tunnel route dns transitsync transitsync.me
cloudflared tunnel route dns transitsync www.transitsync.me
cloudflared tunnel route dns transitsync api.transitsync.me
```

…or add them by hand in **Cloudflare → DNS → Records** (Proxied / orange cloud):

| Type | Name | Target |
|---|---|---|
| CNAME | `@` (transitsync.me) | `3ded8397-d740-44a9-8831-43b8a867b268.cfargotunnel.com` |
| CNAME | `www` | `3ded8397-d740-44a9-8831-43b8a867b268.cfargotunnel.com` |
| CNAME | `api` | `3ded8397-d740-44a9-8831-43b8a867b268.cfargotunnel.com` |

> `cloudflared tunnel route dns` fails if a record already exists — finish A3
> first.

### C3. Restart the connector

```bat
net stop cloudflared
net start cloudflared
```

(Or `sc.exe stop cloudflared` / `sc.exe start cloudflared`. Run in an elevated
shell.)

---

## 5. Phase D — Verify (zero cloud dependencies)

```bat
rem 1) Local origin, bypassing Cloudflare entirely:
curl http://127.0.0.1:8080/api/health
curl -I http://127.0.0.1:8080/

rem 2) Through the tunnel / public edge:
curl -I https://transitsync.me/
curl https://transitsync.me/api/health
curl -I https://www.transitsync.me/
```

Expected:

- Local `:8080/api/health` → `200` with `"database":"up"`.
- `https://transitsync.me/` → `200`, SPA HTML, response header `server: cloudflare`.
- `https://transitsync.me/api/health` → `200` (proves tunnel → Caddy → PM2).
- `www` → `301` to the apex.

Confirm no GitHub Pages remains in the path:

```bat
curl -sI https://transitsync.me/ | findstr /I "x-github x-served-by via"
```

Those headers must be **gone**.

Session cookie check (proves `X-Forwarded-Proto` handling): sign in, then

```bat
curl -sI https://transitsync.me/api/auth/me
```

Sessions still work because the browser↔Cloudflare leg is HTTPS and Caddy
forces `X-Forwarded-Proto: https` to Express, so the cookie keeps its `Secure`
flag.

---

## 6. Rollback

- **Tunnel only:** restore `%USERPROFILE%\.cloudflared\config.yml.bak`, then
  `net stop cloudflared && net start cloudflared`.
- **DNS:** re-create the GitHub Pages records and re-add `transitsync.me` under
  GitHub → Settings → Pages → Custom domain.
- **Local:** `pm2 delete transitsync-api`, `caddy stop`.

Every step is reversible and no repository history is touched.

---

## 7. Applied on this host — 2026-10-15 (verified)

| Item | Result |
|---|---|
| PM2 | 7.0.4, `C:\Users\Administrator\AppData\Roaming\npm` |
| `deploy.bat` | runs green, all 5 steps, exit 0; `pm2 save` done |
| PM2 app | `transitsync-api` online, `fork`, 1 instance |
| Caddy | 2.11.7 at `C:\Caddy\caddy.exe`, added to User PATH |
| `caddy validate --config Caddyfile` | **Valid configuration** |
| `server/.env` | `HOST=127.0.0.1` added |
| Listeners | `127.0.0.1:8080` (Caddy), `127.0.0.1:3100` (Express) — loopback only |
| `GET 127.0.0.1:8080/api/health` | 200, `database:up` |
| `GET 127.0.0.1:8080/` and `/students` | 200 SPA + deep-link fallback |
| gzip | `Content-Encoding: gzip` on `/assets/*.css` |
| Running Caddy config | contains `X-Forwarded-Proto` (admin API `:2019`) |
| cloudflared | restarted with the new ingress |
| `https://api.transitsync.me/api/health` | **200 healthy** (edge → tunnel → Caddy → API) |
| `https://transitsync.me/api/health` | still **404** — apex still on GitHub Pages (pending A2/A3 + C2) |

Two corrections made while applying this:

1. **`deploy.bat` bug** — `pm2 describe ...` must be `call pm2 describe ...`. Invoking
   the `pm2.cmd` shim from a batch file *without* `call` transfers control away and
   the script never resumes (silent early exit).
2. **Cluster → fork** — the SSE hub (`server/src/services/realtime.js`) is an
   in-process singleton, so cluster workers cannot fan out to each other's SSE
   clients. `ecosystem.config.js` now uses `instances: 1` / `exec_mode: 'fork'`.

Not yet verified: an authenticated login through Caddy. The database contains a
single user (`you@you.com`); the `SUPER_ADMIN_*` / `BOOTSTRAP_ADMIN_*` accounts
are not seeded. Once a real password exists, confirm the cookie is `Secure`:

```bat
curl -sD- -oNUL -X POST http://127.0.0.1:8080/api/auth/login ^
  -H "Content-Type: application/json" ^
  --data "{\"email\":\"<you@you.com>\",\"password\":\"<pw>\"}"
```

The `Set-Cookie` must include `Secure` — that proves the `X-Forwarded-Proto`
hand-off at the end of section 1.

---

## 8. Starting the site (manual by design)

Auto-start at boot is **OFF**. The site comes up only when you run the desktop
live console:

```
C:\SYP\start-transitsync-console.bat        (double-click)
C:\SYP\start-transitsync-console.bat stop   (stop it, no window)
```

That window owns the whole stack and streams every line all three processes print
— boot banner, request log, RFID scans, tunnel status, warnings, stack traces —
into the window **and** into `C:\SYP\logs\transitsync-console.log`:

| Process | Command | Listens on |
|---|---|---|
| Caddy | `caddy run --config Caddyfile` | `127.0.0.1:8080` (tunnel origin) |
| API   | `node server/src/index.js` | `127.0.0.1:3100` |
| cloudflared | `cloudflared --config %USERPROFILE%\.cloudflared\config.yml tunnel run` | outbound only → `transitsync.me` |

It first evicts any previous instance (`pm2 stop transitsync-api`, anything still
holding `:3000`, a running Caddy, and the `cloudflared` **service** if it happens
to be running), then hands the children to `scripts\console-supervisor.mjs`. That
supervisor is a **single writer** that fans their combined output to the console
and the log file — one process, one handle, which is why it is used instead of
`>>` redirections (multiple `cmd` writers to one file clash on Windows and the
later process silently fails to start).

- **Closing the window (or Ctrl+C) takes the site OFFLINE** — all three children
  live in that window's process tree, so the tunnel disconnects with them.
- The tunnel is a **foreground child**, never the Windows service: the service
  `Cloudflared` is set to **Manual** so it never connects on its own. The console
  stops that service before starting its own connector so the two can't
  double-register the tunnel.
- If `cloudflared` (or its config) is missing, the console still brings up the
  local stack and prints a warning — the site is then reachable only on
  `127.0.0.1:8080`.
- Requires **Node**, **Caddy** (`C:\Caddy\caddy.exe`) and (for the public site)
  **cloudflared** (`C:\Program Files\cloudflared\cloudflared.exe`); the launcher
  builds `client\dist` automatically on first run.

### Why the API no longer runs under PM2 here

The console runs the API directly so the window's lifetime *is* the site's
lifetime. `ecosystem.config.js` and `deploy.bat` still support the background PM2
path if you ever want it; the console stops the PM2 copy first so the two never
contend for `:3000`.

### Re-enabling auto-start (optional)

The `TransitSync-Caddy` and `TransitSync-PM2` tasks still exist but are
**Disabled**:

```bat
powershell Get-ScheduledTask -TaskName 'TransitSync-*' | Select TaskName,State
powershell Enable-ScheduledTask  -TaskName 'TransitSync-*'      REM re-enable boot start
```

Installed by `scripts\install-autostart.ps1` (re-runnable, `-Force`); they run at
startup as `Administrator` with an **S4U logon** (no password stored) and
restart-on-failure, because `caddy.exe` is not a service binary and
NSSM/WinSW are not on this host. Boot-path log: `C:\SYP\scripts\pm2-boot.log`.

> If you re-enable auto-start, don't also run the console for the API — the two
> would fight over `:3000`.
