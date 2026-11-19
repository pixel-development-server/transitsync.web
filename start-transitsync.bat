@echo off
rem ===========================================================================
rem  TransitSync launcher (local)
rem
rem  Starts the TransitSync API (which also serves the built React console),
rem  waits until it reports healthy, then opens the console in your browser.
rem
rem  Boot is a NUMBERED, SEQUENTIAL preflight: the window is cleared first, then
rem  every resource is checked and loaded before the next one starts:
rem
rem     [1/6] Node.js runtime
rem     [2/6] Project files
rem     [3/6] Web console build (rebuild when sources changed)
rem     [4/6] Already-running check
rem     [5/6] Start the API
rem     [6/6] Wait for the server to become healthy
rem
rem  The server runs in its own window, so closing this one leaves TransitSync
rem  running. Close the "TransitSync API" window to stop it.
rem ===========================================================================

setlocal EnableExtensions

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "SERVER_DIR=%APP_DIR%\server"
set "PORT=3100"
set "URL=http://localhost:%PORT%"
rem Probe the literal IPv4 address: the API binds 0.0.0.0, but `localhost`
rem resolves to ::1 on many machines and the IPv6 attempt just times out.
set "HEALTH=http://127.0.0.1:%PORT%/api/health"
set "LOG=%SERVER_DIR%\launcher.log"
set "WAIT=%APP_DIR%\scripts\wait-for-server.mjs"

rem Wipe everything a previous session may have left on screen.
cls

set /a STEP=0
set "STEPS=6"

echo.
echo    TransitSync   RFID campus shuttle operations console
echo    ------------------------------------------------------
echo.
echo    Checking and loading each resource, one at a time.
echo.

rem --- [1/6] Node.js runtime -------------------------------------------------
set /a STEP+=1
call :begin "Checking Node.js runtime"
where node >nul 2>nul
if errorlevel 1 goto :no_node
call :ok

rem --- [2/6] project files ---------------------------------------------------
set /a STEP+=1
call :begin "Checking project files"
if not exist "%SERVER_DIR%\src\index.js" goto :no_server
call :ok

rem --- [3/6] web console build -----------------------------------------------
rem  Sync the brand icon and rebuild the console whenever a source file is newer
rem  than the last build, so an edit made since the previous start is live before
rem  the browser opens. scripts\prepare-client.mjs prints the status itself.
set /a STEP+=1
call :begin "Checking the web console build"
node "%APP_DIR%\scripts\prepare-client.mjs"
if errorlevel 1 goto :build_failed
echo.

rem --- [4/6] already running? ------------------------------------------------
set /a STEP+=1
call :begin "Checking for an already-running server"
node "%WAIT%" "%HEALTH%" 1500 >nul 2>&1
if not errorlevel 1 goto :already_running
call :okmsg "not running yet"

rem --- [5/6] start the API ---------------------------------------------------
set /a STEP+=1
call :begin "Starting the API"
if exist "%LOG%" del /q "%LOG%" >nul 2>&1
start "TransitSync API" /MIN /D "%SERVER_DIR%" cmd /c node src\index.js ^>launcher.log 2^>^&1
call :ok

rem --- [6/6] wait for health -------------------------------------------------
set /a STEP+=1
call :begin "Waiting for the server to become healthy"
node "%WAIT%" "%HEALTH%" 45000 >nul 2>&1
if errorlevel 1 goto :not_healthy
call :ok
goto :live

rem ===========================================================================
rem  Outcomes
rem ===========================================================================
:already_running
echo    [i] TransitSync is already running on port %PORT%.
echo        Opening the console...
echo.
echo        Reachable from other devices on the same Wi-Fi/LAN, or over a VPN/Tailscale:
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4).Where({$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'}).ForEach({'http://' + $_.IPAddress + ':%PORT%'})"`) do echo          %%i
echo.
start "" "%URL%"
endlocal
exit /b 0

:live
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
endlocal
exit /b 0

:no_node
call :fail
echo.
echo    [X] Node.js 20 or newer is required, but it was not found on PATH.
echo        Install it from https://nodejs.org/ and run this again.
echo.
pause
exit /b 1

:no_server
call :fail
echo.
echo    [X] Cannot find the TransitSync server at:
echo        %SERVER_DIR%\src\index.js
echo.
pause
exit /b 1

:build_failed
echo.
echo    [X] The web console failed to build. Review the output above.
echo.
pause
exit /b 1

:not_healthy
call :fail
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

:okmsg
echo OK  ^(%~1^)
goto :eof

:fail
echo FAILED
goto :eof
