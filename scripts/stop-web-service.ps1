# ===========================================================================
#  Stop the always-on TransitSync web service (and its orphaned children).
#  Run as Administrator. The site stays offline until the task is started
#  again or the machine reboots.
# ===========================================================================
$ErrorActionPreference = 'SilentlyContinue'
$name = 'TransitSync-Web'

Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*console-supervisor.mjs*') -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'src[\\/]index\.js') -or
  ($_.Name -eq 'caddy.exe') -or
  ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*tunnel run*')
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Remove-Item 'C:\SYP\logs\transitsync-service.active' -Force -ErrorAction SilentlyContinue
Write-Output 'TransitSync web service stopped.'
