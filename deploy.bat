@echo off
rem ===========================================================================
rem  TransitSync - local deployment (Windows homelab)
rem
rem  Builds the frontend, refreshes backend dependencies, reloads/starts the
rem  API under PM2, and starts/reloads Caddy. Nothing is pushed anywhere:
rem  no git remote, no CI, no webhook.
rem
rem  Usage:  deploy.bat
rem
rem  Schema migrations run automatically inside the API on boot
rem  (server/src/index.js), so a PM2 reload is all the backend needs after a
rem  schema change. Caddy serves client\dist straight from disk, so a rebuild
rem  needs no Caddy reload; only a Caddyfile edit does.
rem ===========================================================================
setlocal enableextensions
set "ROOT=%~dp0"

cd /d "%ROOT%" || (echo [x] Could not enter "%ROOT%" & exit /b 1)

echo.
echo ==^> [1/5] Building the frontend
pushd "%ROOT%client" || (echo [x] Missing client directory & exit /b 1)
call npm install || (popd & goto :fail)
call npm run build || (popd & goto :fail)
popd

echo.
echo ==^> [2/5] Updating backend dependencies
pushd "%ROOT%server" || (echo [x] Missing server directory & exit /b 1)
call npm install || (popd & goto :fail)
popd

echo.
echo ==^> [3/5] Checking PM2
where pm2 >nul 2>&1
if errorlevel 1 (
  echo [x] PM2 is not on PATH. Install it once with:  npm install -g pm2
  goto :fail
)

echo.
echo ==^> [4/5] Reloading the API under PM2
rem NOTE: `call` is required. pm2 is a .cmd shim; invoking it from a batch
rem without `call` hands over control and the script never resumes.
call pm2 describe transitsync-api >nul 2>&1
if errorlevel 1 (
  echo     process not running - starting it
  call pm2 start ecosystem.config.js || goto :fail
) else (
  echo     process running - reloading
  call pm2 reload ecosystem.config.js --update-env || goto :fail
)

rem  GATE: never point Caddy at :3100 before the API is actually listening,
rem  otherwise it logs "connectex: ... actively refused it" (HTTP 502).
echo ==^> [4b/5] Waiting for the API on 127.0.0.1:3100
node "%ROOT%scripts\wait-for-server.mjs" "http://127.0.0.1:3100/api/health" 60000
if errorlevel 1 (
  echo     [x] The API did not answer /api/health within 60s - not starting Caddy.
  goto :fail
)

echo.
echo ==^> [5/5] Ensuring Caddy is serving client\dist
where caddy >nul 2>&1
if errorlevel 1 (
  echo     [!] Caddy is not on PATH - skipping.
  echo         Install it once, then run:  caddy start --config Caddyfile
) else (
  rem `reload` succeeds only when Caddy is already running; otherwise start it.
  call caddy reload --config Caddyfile >nul 2>&1
  if errorlevel 1 (
    echo     not running - starting Caddy on 127.0.0.1:8080
    call caddy start --config Caddyfile || goto :fail
  ) else (
    echo     Caddy reloaded
  )
)

echo.
echo  Deployment complete.
echo    Console : https://transitsync.me
echo    Health  : https://transitsync.me/api/health
exit /b 0

:fail
echo.
echo  [x] Deployment failed - see the output above.
exit /b 1
