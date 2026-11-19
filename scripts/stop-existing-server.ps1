# ===========================================================================
#  Evict a previous / lingering TransitSync stack before the console starts.
#
#  Used by start-transitsync-console.bat so a stale instance cannot make the
#  new one fail with EADDRINUSE or leave a dead reverse proxy behind. It only
#  touches things this project owns:
#
#    1. node processes LISTENING on the ports we are about to bind
#    2. a previous console supervisor (node .../console-supervisor.mjs)
#    3. optionally (-IncludeCaddy) a stray caddy.exe — the console is the only
#       thing on this host that runs Caddy
#
#  It deliberately does NOT kill arbitrary node.exe (that would take out the
#  PM2 daemon or unrelated tooling).
# ===========================================================================
param(
  [int[]]$Port = @(3100, 8080),
  [switch]$IncludeCaddy
)

$stopped = @()

# 1) node processes holding any of the target ports.
foreach ($p in $Port) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
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
}

# 2) a previous console supervisor (killed here so a fresh one can own the log).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine -like '*console-supervisor.mjs*') {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      $stopped += $_.ProcessId
    } catch {
      # Already gone.
    }
  }
}

# 3) a stray Caddy (opt-in).
if ($IncludeCaddy) {
  Get-Process caddy -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      Stop-Process -Id $_.Id -Force -ErrorAction Stop
      $stopped += $_.Id
    } catch {
      # Already gone.
    }
  }
}

$stopped = $stopped | Select-Object -Unique
if ($stopped.Count -gt 0) {
  Write-Output ("  [i] Evicted a previous TransitSync instance (PID {0})." -f ($stopped -join ', '))
}
