@echo off
rem ===========================================================================
rem  TransitSync -- LIVE CONSOLE  (this window owns the whole website)
rem
rem  Starts the three processes the public site runs on, one after another:
rem     * API         node  server\src\index.js               127.0.0.1:3100
rem     * Caddy       caddy run --config Caddyfile            127.0.0.1:8080  (tunnel origin)
rem     * cloudflared cloudflared --config <cfg> tunnel run    public: transitsync.me
rem
rem  Boot is a NUMBERED, SEQUENTIAL preflight: the window is cleared first (so
rem  nothing from a previous session lingers on screen) and then every resource
rem  is checked and loaded before the next one starts:
rem
rem     [1/7] Node.js runtime
rem     [2/7] Project files
rem     [3/7] Caddy
rem     [4/7] cloudflared tunnel
rem     [5/7] Web console build (rebuild when sources changed)
rem     [6/7] Free ports / stop any previous instance
rem     [7/7] Hand over: API -> Caddy -> tunnel
rem
rem  Everything they print -- the boot banner, request lines, RFID
rem  scans, warnings and stack traces -- is written to
rem        logs\transitsync-console.log
rem  and streamed live in THIS window.
rem
rem  TWO WAYS THIS WINDOW RUNS
rem    * VIEWER (normal) - the always-on TransitSync-Web service owns the stack.
rem      This window only streams the log; closing it does NOT take the site
rem      offline. Install it with scripts\install-web-service.ps1.
rem    * OWNER (fallback) - if that service stamp is absent, this window starts
rem      and owns the stack. Closing it DOES take the site offline for everyone.
rem
rem  Usage:
rem     start-transitsync-console.bat         start the site + stream logs
rem     start-transitsync-console.bat stop    stop the site, no window
rem ===========================================================================
setlocal EnableExtensions
title TransitSync - LIVE CONSOLE - viewer attaches to always-on service

rem UTF-8 so the server banner / em dash render correctly.
chcp 65001 >nul 2>&1

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "SERVER_DIR=%APP_DIR%\server"
set "LOG_DIR=%APP_DIR%\logs"
set "LOG=%LOG_DIR%\transitsync-console.log"
set "PORT=3100"
set "PROXY_PORT=8080"
set "CADDY="
for /f "delims=" %%i in ('where caddy 2^>nul') do if not defined CADDY set "CADDY=%%i"
if not defined CADDY if exist "C:\Caddy\caddy.exe" set "CADDY=C:\Caddy\caddy.exe"

rem --- cloudflared (public tunnel) + its ingress config ----------------------
set "CLOUDFLARED="
for /f "delims=" %%i in ('where cloudflared 2^>nul') do if not defined CLOUDFLARED set "CLOUDFLARED=%%i"
if not defined CLOUDFLARED if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CLOUDFLARED=%ProgramFiles%\cloudflared\cloudflared.exe"
set "TUNNEL_CONFIG=%USERPROFILE%\.cloudflared\config.yml"

rem --- `... stop` : shut the site down and exit (no log streaming) -----------
if /i "%~1"=="stop" goto :stop_only

rem --- VIEWER MODE ---------------------------------------------------------
rem When the always-on service owns the stack, attaching as a viewer avoids
rem the port-killing preflight below (which would take the service down).
if exist "%LOG_DIR%\transitsync-service.active" goto :viewer

rem Wipe everything a previous session may have left on screen.
cls

set /a STEP=0
set "STEPS=7"

echo.
echo   ================================================================
echo     TransitSync  --  LIVE CONSOLE
echo     Caddy :%PROXY_PORT%  ^-^>  API :%PORT%      public: transitsync.me (tunnel)
echo   ================================================================
echo.
echo   Checking and loading each resource, one at a time.
echo.

rem --- [1/7] Node.js runtime -------------------------------------------------
set /a STEP+=1
call :begin "Checking Node.js runtime"
where node >nul 2>nul
if errorlevel 1 goto :no_node
call :ok

rem --- [2/7] project files ---------------------------------------------------
set /a STEP+=1
call :begin "Checking project files"
if not exist "%SERVER_DIR%\src\index.js" goto :no_server
call :ok

rem --- [3/7] Caddy -----------------------------------------------------------
set /a STEP+=1
call :begin "Checking Caddy"
if not defined CADDY goto :no_caddy
call :ok

rem --- [4/7] cloudflared tunnel ----------------------------------------------
set /a STEP+=1
call :begin "Checking cloudflared tunnel"
if not defined CLOUDFLARED goto :tunnel_off
if not exist "%TUNNEL_CONFIG%" goto :tunnel_off
call :ok
goto :after_tunnel

:tunnel_off
call :warn
echo            cloudflared or its config was not found, so the PUBLIC
echo            tunnel (transitsync.me) will stay OFFLINE. The local stack
echo            on 127.0.0.1:%PROXY_PORT% will still run.
echo.

:after_tunnel

rem --- [5/7] web console build -----------------------------------------------
rem  Sync the brand icon and rebuild the console whenever a source file is newer
rem  than the last build. Caddy serves client\dist straight from disk, so a fresh
rem  build is picked up without reloading Caddy.
set /a STEP+=1
call :begin "Checking the web console build"
node "%APP_DIR%\scripts\prepare-client.mjs"
if errorlevel 1 goto :build_failed
echo.

rem --- [6/7] free the ports ------------------------------------------------
set /a STEP+=1
call :begin "Freeing ports / stopping any previous instance"
call :stop_pm2
rem  Kill lingering node on :3100 / :8080, a stale console supervisor and any
rem  stray Caddy, so the ports are provably free before we start.
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\stop-existing-server.ps1" -IncludeCaddy >nul 2>&1
rem  Kill a leftover foreground tunnel connector from a previous console.
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\stop-console-tunnel.ps1" >nul 2>&1
rem  Ensure the cloudflared WINDOWS SERVICE is not also connected to the tunnel
rem  (this window runs its own foreground connector; two would double-register).
sc query cloudflared 2>nul | findstr /I "RUNNING" >nul 2>&1
if not errorlevel 1 net stop cloudflared >nul 2>&1
call :ok

rem --- [7/7] hand over -------------------------------------------------------
set /a STEP+=1
call :begin "Starting services"
echo API :%PORT%  ^-^>  Caddy :%PROXY_PORT%  ^-^>  tunnel
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
echo.
echo   ================================================================
echo     LIVE  --  activity and errors from ALL THREE processes stream below
echo     (also saved to logs\transitsync-console.log)
echo     Close this window (or press Ctrl+C) to take the site OFFLINE.
echo   ================================================================
echo.

rem  One Node process spawns the API, Caddy and the cloudflared tunnel and fans
rem  their combined output to this console AND logs\transitsync-console.log. It
rem  is a direct child of this window, so closing the window stops everything.
rem  (A single writer also avoids the Windows `>>` handle clash that multiple
rem  redirections would hit.)
set "TRANSITSYNC_CADDY=%CADDY%"
set "TRANSITSYNC_CLOUDFLARED=%CLOUDFLARED%"
set "TRANSITSYNC_TUNNEL_CONFIG=%TUNNEL_CONFIG%"
node "%APP_DIR%\scripts\console-supervisor.mjs"

rem --- Reached after Ctrl+C / the supervisor exits: belt-and-braces cleanup --
echo.
echo   [.] Stopping TransitSync...
"%CADDY%" stop >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\stop-existing-server.ps1" -Port %PORT% >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\stop-console-tunnel.ps1" >nul 2>&1
echo   ================================================================
echo     OFFLINE  --  the website is down until you run this again.
echo   ================================================================
echo.
pause
endlocal
exit /b 0

rem ===========================================================================
rem  viewer path - attached to the always-on service, owns nothing
rem ===========================================================================
:viewer
title TransitSync - LIVE CONSOLE (VIEWER - attached to always-on service)
echo.
echo   ================================================================
echo     TransitSync  --  LIVE CONSOLE  (VIEWER MODE)
echo     The always-on TransitSync-Web service owns the site.
echo     Closing this window does NOT take the site offline.
echo   ================================================================
echo.
echo   Streaming %LOG%  (Ctrl+C to stop watching)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath '%LOG%' -Wait -Tail 50"
echo.
echo   [.] Stopped watching. The site is still running in the background.
pause
endlocal
exit /b 0

rem ===========================================================================
rem  stop-only path
rem ===========================================================================
:stop_only
echo   [.] Stopping TransitSync...
rem Stop the always-on service too (needs elevation; ignore if not available).
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\stop-web-service.ps1" >nul 2>&1
call :stop_pm2
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\stop-existing-server.ps1" -IncludeCaddy
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\stop-console-tunnel.ps1"
sc query cloudflared 2>nul | findstr /I "RUNNING" >nul 2>&1
if not errorlevel 1 net stop cloudflared >nul 2>&1
echo   [OK] Site stopped.
echo.
endlocal
exit /b 0

rem ===========================================================================
rem  Failure exits
rem ===========================================================================
:no_node
call :fail
echo.
echo   [X] Node.js 20 or newer is required but was not found on PATH.
echo       Install it from https://nodejs.org/ and run this again.
echo.
pause
exit /b 1

:no_server
call :fail
echo.
echo   [X] Cannot find the TransitSync server at:
echo       %SERVER_DIR%\src\index.js
echo.
pause
exit /b 1

:no_caddy
call :fail
echo.
echo   [X] Caddy was not found ^(it is required as the Cloudflare Tunnel origin^).
echo       Install it to C:\Caddy\caddy.exe, or put it on PATH, then retry.
echo.
pause
exit /b 1

:build_failed
echo.
echo   [X] The web console failed to build. Review the output above.
echo.
pause
exit /b 1

rem ===========================================================================
rem  Subroutines
rem ===========================================================================

:begin
rem  Print "[n/total] label ... " with no trailing newline.
<nul set /p "=   [%STEP%/%STEPS%] %~1 ... "
goto :eof

:ok
echo OK
goto :eof

:warn
echo WARN
goto :eof

:fail
echo FAILED
goto :eof

:stop_pm2
rem  Ask PM2 to release :3100 ONLY when its daemon is already running, so we
rem  never spawn a background daemon just to stop nothing.
set "PM2_DAEMON="
for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\pm2-daemon-running.ps1" 2^>nul') do set "PM2_DAEMON=%%i"
if /i "%PM2_DAEMON%"=="yes" call pm2 stop transitsync-api >nul 2>&1
set "PM2_DAEMON="
goto :eof
