# ===========================================================================
#  TransitSync — outage watchdog.
#
#  Every 5 minutes (scheduled task, SYSTEM) check the local origin. If it is
#  not answering, cleanly stop the web task and any orphaned children, then
#  start it again. This is the last line of defence behind the supervisor's
#  per-child respawn and the task scheduler's own restart-on-failure.
# ===========================================================================
$ErrorActionPreference = 'SilentlyContinue'
$name = 'TransitSync-Web'
$log = 'C:\SYP\logs\transitsync-watchdog.log'

$healthy = $false
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:8080/api/health' -UseBasicParsing -TimeoutSec 8
  $healthy = ($r.StatusCode -eq 200)
} catch { $healthy = $false }

if ($healthy) { exit 0 }

function Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format o), $msg
  Add-Content -LiteralPath $log -Value $line
}

Log 'origin health check failed - restarting the web service'

Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# Remove orphans from the previous, failed instance so the ports are free.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*console-supervisor.mjs*') -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'src[\\/]index\.js') -or
  ($_.Name -eq 'caddy.exe') -or
  ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*tunnel run*')
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Remove-Item 'C:\SYP\logs\transitsync-service.active' -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $name
Log 'restart issued'
