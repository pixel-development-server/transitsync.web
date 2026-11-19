# ===========================================================================
#  TransitSync — always-on web service body.
#
#  Invoked by the TransitSync-Web scheduled task (SYSTEM, session 0), so it
#  survives RDP logoffs and reboots. It applies no port-killing preflight: it
#  is the single owner of the stack. The desktop launcher detects the stamp
#  file written by the supervisor and attaches as a viewer instead.
# ===========================================================================
$ErrorActionPreference = 'Stop'
$root = 'C:\SYP'
Set-Location $root

$env:TRANSITSYNC_CADDY          = 'C:\Caddy\caddy.exe'
$env:TRANSITSYNC_CLOUDFLARED    = 'C:\Program Files\cloudflared\cloudflared.exe'
$env:TRANSITSYNC_TUNNEL_CONFIG  = 'C:\Users\Administrator\.cloudflared\config.yml'
$env:TRANSITSYNC_API_PORT       = '3100'
$env:TRANSITSYNC_PROXY_PORT     = '8080'

# Keep the served console build current before the proxy starts. Only rebuilds
# when sources changed, and vite keeps old hashed assets (emptyOutDir: false).
& node "$root\scripts\prepare-client.mjs"
if ($LASTEXITCODE -ne 0) { throw 'TransitSync client build failed' }

# This foreground connector must be the ONLY one attached to the tunnel.
$svc = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { Stop-Service cloudflared -Force }

& node "$root\scripts\console-supervisor.mjs" --service
exit $LASTEXITCODE
