# ---------------------------------------------------------------------------
# TransitSync - install auto-start for Caddy + PM2 as Windows Scheduled Tasks.
#
#   OPTIONAL. Starting at boot is OFF by default: the site is normally started
#   (and logged) by hand via start-transitsync-console.bat. Run this only if you
#   want the site to come back by itself after a reboot.
#
#   Run elevated:  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#
# Both tasks run at system startup as the Administrator account using an S4U
# logon (no password stored; runs whether or not anyone is signed in), with
# restart-on-failure. This is the dependency-free alternative to NSSM/WinSW,
# which are not available on this host.
#
#   Disable :  Get-ScheduledTask -TaskName 'TransitSync-*' | Disable-ScheduledTask
#   Enable  :  Get-ScheduledTask -TaskName 'TransitSync-*' | Enable-ScheduledTask
#   Remove  :  Unregister-ScheduledTask -TaskName TransitSync-Caddy,TransitSync-PM2
# ---------------------------------------------------------------------------
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$root   = 'C:\SYP'
$caddy  = 'C:\Caddy\caddy.exe'
$pm2bat = Join-Path $root 'scripts\start-pm2.bat'
$who    = "$env:COMPUTERNAME\Administrator"

$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType S4U -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

function New-BootTask {
  param($Name, $Action, $DelaySeconds, $Description)
  $trigger = New-ScheduledTaskTrigger -AtStartup
  try { $trigger.Delay = "PT${DelaySeconds}S" } catch { }
  Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description $Description -Force | Out-Null
}

# 1) Caddy: foreground process held by the task (restarts on crash).
New-BootTask -Name 'TransitSync-Caddy' -DelaySeconds 15 `
  -Action (New-ScheduledTaskAction -Execute $caddy `
    -Argument "run --config `"$root\Caddyfile`"" -WorkingDirectory $root) `
  -Description 'TransitSync: Caddy reverse proxy + SPA server (127.0.0.1:8080)'

# 2) PM2: restore the saved process list (the daemon it spawns keeps running).
New-BootTask -Name 'TransitSync-PM2' -DelaySeconds 30 `
  -Action (New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument "/c `"$pm2bat`"" -WorkingDirectory $root) `
  -Description 'TransitSync: PM2 resurrect (API on 127.0.0.1:3100)'

Get-ScheduledTask -TaskName 'TransitSync-*' |
  Select-Object TaskName, State, @{n='Trigger';e={ ($_.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ',' }}, @{n='RunAs';e={ $_.Principal.UserId }} |
  Format-Table -AutoSize
