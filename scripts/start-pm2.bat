@echo off
rem ---------------------------------------------------------------------------
rem  TransitSync - PM2 boot action.
rem  Run by the "TransitSync-PM2" scheduled task at startup. It restores the
rem  saved PM2 process list (that is how the API comes back after a reboot).
rem ---------------------------------------------------------------------------
set "PATH=C:\Program Files\nodejs;C:\Users\Administrator\AppData\Roaming\npm;%PATH%"
set "PM2_HOME=C:\Users\Administrator\.pm2"

echo [%date% %time%] PM2 boot: resurrecting >> "C:\SYP\scripts\pm2-boot.log"
call "C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" resurrect >> "C:\SYP\scripts\pm2-boot.log" 2>&1
call "C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" save      >> "C:\SYP\scripts\pm2-boot.log" 2>&1
echo [%date% %time%] PM2 boot: done >> "C:\SYP\scripts\pm2-boot.log"
exit /b 0
