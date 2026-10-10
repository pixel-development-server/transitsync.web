@echo off
rem ===========================================================================
rem  TransitSync launcher
rem
rem  Starts the TransitSync API (which also serves the built React console),
rem  waits until it reports healthy, then opens the console in your browser.
rem
rem  The server runs in its own window, so closing this one leaves TransitSync
rem  running. Close the "TransitSync API" window to stop it.
rem ===========================================================================

setlocal EnableExtensions

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "SERVER_DIR=%APP_DIR%\server"
set "CLIENT_DIR=%APP_DIR%\client"
set "PORT=8080"
set "URL=http://localhost:%PORT%"
rem Probe the literal IPv4 address: the API binds 0.0.0.0, but `localhost`
rem resolves to ::1 on many machines and the IPv6 attempt just times out.
set "HEALTH=http://127.0.0.1:%PORT%/api/health"
set "LOG=%SERVER_DIR%\launcher.log"
set "WAIT=%APP_DIR%\scripts\wait-for-server.mjs"

echo.
echo    TransitSync   RFID campus shuttle operations console
echo    ------------------------------------------------------
echo.

rem --- Node is a hard requirement -------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo    [X] Node.js 20 or newer is required, but it was not found on PATH.
    echo        Install it from https://nodejs.org/ and run this again.
    echo.
    pause
    exit /b 1
)

if not exist "%SERVER_DIR%\src\index.js" (
    echo    [X] Cannot find the TransitSync server at:
    echo        %SERVER_DIR%
    echo.
    pause
    exit /b 1
)

rem --- Already serving?  Then just open the console --------------------------
node "%WAIT%" "%HEALTH%" 1500 >nul 2>&1
if not errorlevel 1 (
    echo    [i] TransitSync is already running on port %PORT%.
    echo        Opening the console...
    echo.
    echo        Reachable from other devices on the same Wi-Fi/LAN, or over a VPN/Tailscale:
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4).Where({$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'}).ForEach({'http://' + $_.IPAddress + ':%PORT%'})"`) do echo          %%i
    echo.
    start "" "%URL%"
    exit /b 0
)

rem --- The API serves client\dist, so build it if it has never been built ----
if not exist "%CLIENT_DIR%\dist\index.html" (
    echo    [.] Building the web console ^(first run only^)...
    pushd "%CLIENT_DIR%"
    call npm.cmd run build
    if errorlevel 1 (
        popd
        echo.
        echo    [X] The console failed to build. Review the output above.
        echo.
        pause
        exit /b 1
    )
    popd
    echo.
)

rem --- Launch the API in its own window -------------------------------------
echo    [.] Starting the TransitSync API...
if exist "%LOG%" del /q "%LOG%" >nul 2>&1
start "TransitSync API" /MIN /D "%SERVER_DIR%" cmd /c node src\index.js ^>launcher.log 2^>^&1

set "READY="
node "%WAIT%" "%HEALTH%" 45000 >nul 2>&1
if not errorlevel 1 set "READY=1"

if not defined READY (
    echo.
    echo    [X] The server did not become healthy within 45 seconds.
    echo.
    echo    ---- launcher.log -----------------------------------------
    if exist "%LOG%" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath '%LOG%' -Tail 25" 2>nul
    ) else (
        echo    ^(no log was produced^)
    )
    echo    ----------------------------------------------------------
    echo.
    pause
    exit /b 1
)

echo.
echo    [OK] TransitSync is live.
echo.
echo        On this PC   %URL%
echo        API          %HEALTH%
echo        Log          %LOG%
echo.
echo    Reachable from other devices on the same Wi-Fi/LAN, or over a VPN/Tailscale:
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4).Where({$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'}).ForEach({'http://' + $_.IPAddress + ':%PORT%'})"`) do echo        %%i
echo.
echo    The server is running in the minimised "TransitSync API" window.
echo    Close that window to stop TransitSync.
echo.
start "" "%URL%"
echo.
pause
exit /b 0