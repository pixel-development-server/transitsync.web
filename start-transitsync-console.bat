@echo off
rem ===========================================================================
rem  TransitSync -- server console (VISIBLE)
rem
rem  Runs the TransitSync API in THIS window. The API also serves the built
rem  React console, so this single process is what every other device on the
rem  network connects to. Live request logs, scan activity and errors stream
rem  here in real time.
rem
rem      Closing this window  ==  the web panel goes OFFLINE for everyone.
rem
rem  Press Ctrl+C to stop cleanly (waits for open streams to close), or just
rem  close the window to stop it immediately.
rem ===========================================================================

setlocal EnableExtensions
title TransitSync Server - LIVE LOGS - closing this window takes the panel OFFLINE

rem UTF-8 so the server's box-drawing banner and the em dash render correctly.
chcp 65001 >nul 2>&1

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "SERVER_DIR=%APP_DIR%\server"
set "CLIENT_DIR=%APP_DIR%\client"
set "PORT=8080"

echo.
echo   ================================================================
echo     TransitSync  --  server console
echo   ================================================================
echo.

rem --- Node is a hard requirement -------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js 20 or newer is required but was not found on PATH.
  echo       Install it from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "%SERVER_DIR%\src\index.js" (
  echo   [X] Cannot find the TransitSync server at:
  echo       %SERVER_DIR%
  echo.
  pause
  exit /b 1
)

rem --- The API serves client\dist, so build it on first run ------------------
if not exist "%CLIENT_DIR%\dist\index.html" (
  echo   [.] First run: building the web console ^(this can take a minute^)...
  pushd "%CLIENT_DIR%"
  call npm.cmd run build
  if errorlevel 1 (
    popd
    echo.
    echo   [X] The console failed to build. Review the output above.
    echo.
    pause
    exit /b 1
  )
  popd
  echo.
)

rem --- Free the port if a previous server is still running -------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\stop-existing-server.ps1" -Port %PORT%

echo   [.] Starting the TransitSync server...
echo   [.] Live logs stream below. Close this window to take the panel OFFLINE.
echo.

rem --- Run in the FOREGROUND so this window owns the server ------------------
rem  Because node is the direct child of this console, closing the window (or
rem  Ctrl+C) terminates it -- which is exactly what takes the panel offline.
cd /d "%SERVER_DIR%"
node src\index.js

rem --- Reached only once the server has stopped ------------------------------
echo.
echo   ================================================================
echo     Server stopped  --  the web panel is now OFFLINE.
echo   ================================================================
echo.
pause
endlocal
