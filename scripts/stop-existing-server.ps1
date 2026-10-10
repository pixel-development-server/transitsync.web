# ===========================================================================
#  Stop a TransitSync server that is already holding the port.
#
#  Used by start-transitsync-console.bat before it starts a fresh server, so a
#  previous (possibly hidden) instance cannot make the new one fail with
#  EADDRINUSE. Only processes named "node" are touched.
# ===========================================================================
param(
  [int]$Port = 8080
)

$stopped = @()

Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') {
    try {
      Stop-Process -Id $proc.Id -Force -ErrorAction Stop
      $stopped += $proc.Id
    } catch {
      # Already gone, or not ours to kill — ignore and let the bind report it.
    }
  }
}

if ($stopped.Count -gt 0) {
  Write-Output ("  [i] Stopped a previous TransitSync server (PID {0})." -f ($stopped -join ', '))
}
