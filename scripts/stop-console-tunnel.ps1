# ===========================================================================
#  Stop the FOREGROUND cloudflared connector that the live console started.
#
#  The Windows service runs in session 0; the console's connector runs in the
#  user's interactive session. So we only touch cloudflared processes in the
#  CURRENT session and leave the service (when it happens to be running) alone.
# ===========================================================================

$sessionId = (Get-Process -Id $PID).SessionId
$stopped = @()

Get-Process cloudflared -ErrorAction SilentlyContinue |
  Where-Object { $_.SessionId -eq $sessionId } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.Id -Force -ErrorAction Stop
      $stopped += $_.Id
    } catch {
      # Already gone, or not ours to kill — ignore.
    }
  }

if ($stopped.Count -gt 0) {
  Write-Output ("  [i] Stopped the console tunnel connector (PID {0})." -f ($stopped -join ', '))
}
