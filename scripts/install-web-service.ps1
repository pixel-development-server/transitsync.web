# ===========================================================================
#  Install the always-on TransitSync web service.
#
#  A scheduled task (not a desktop window) owns API :3100, Caddy :8080 and the
#  cloudflared tunnel. It runs as SYSTEM whether or not anybody is logged on,
#  starts at boot and again shortly after each logon, restarts on failure, and
#  ignores duplicate triggers. Run this once (safe to re-run) as Administrator.
# ===========================================================================
$ErrorActionPreference = 'Stop'
$name = 'TransitSync-Web'
$watchdog = 'TransitSync-Web-Watchdog'
$root = 'C:\SYP'

# --- main service task -----------------------------------------------------
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\SYP\scripts\run-web-service.ps1"' `
  -WorkingDirectory $root

$atStartup = New-ScheduledTaskTrigger -AtStartup
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$atLogon.Delay = 'PT1M'

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($atStartup, $atLogon) `
  -Principal $principal -Settings $settings -Force | Out-Null

# --- watchdog: every 5 minutes, recover from a total outage ----------------
# The supervisor respawns individual children; this catches the case where the
# whole task has exited or its restart budget was exhausted.
$wdAction = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\SYP\scripts\web-watchdog.ps1"' `
  -WorkingDirectory $root
$wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$wdSettings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable

Register-ScheduledTask -TaskName $watchdog -Action $wdAction -Trigger $wdTrigger `
  -Principal $principal -Settings $wdSettings -Force | Out-Null

Write-Output "Installed '$name' (SYSTEM, startup + logon, restart on failure)."
Write-Output "Installed '$watchdog' (every 5 minutes)."
