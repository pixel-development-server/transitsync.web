# ---------------------------------------------------------------------------
# TransitSync - put the LIVE CONSOLE and the LOGS on the desktop.
#
#   Creates two shortcuts for the signed-in user:
#
#     * TransitSync Live Console   ->  cmd /c start-transitsync-console.bat
#                                      (the window that owns the whole website)
#     * TransitSync Logs           ->  opens  C:\SYP\logs
#
#   Idempotent: safe to re-run to repair a moved/renamed shortcut. It also
#   retires the older "TransitSync Server" shortcut, which launched the very
#   same console under a less clear name.
#
#   Run as the user whose desktop you want (no elevation needed):
#       powershell -ExecutionPolicy Bypass -File scripts\create-desktop-shortcuts.ps1
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot          # C:\SYP
$launcher = Join-Path $root 'start-transitsync-console.bat'
$logsDir  = Join-Path $root 'logs'
$icon     = Join-Path $root 'assets\transitsync.ico'
$desktop  = [Environment]::GetFolderPath('Desktop')

if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }
if (-not (Test-Path $logsDir))  { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

$ws = New-Object -ComObject WScript.Shell
$made = @()

# --- live console ----------------------------------------------------------
$consoleLnk = Join-Path $desktop 'TransitSync Live Console.lnk'
$s = $ws.CreateShortcut($consoleLnk)
$s.TargetPath       = "$env:SystemRoot\System32\cmd.exe"
$s.Arguments        = "/c `"$launcher`""
$s.WorkingDirectory = $root
$s.Description      = 'Start TransitSync in a live console. Closing the window takes the web panel offline.'
$s.WindowStyle      = 1
if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
$s.Save()
$made += 'TransitSync Live Console.lnk'

# --- logs ------------------------------------------------------------------
$logsLnk = Join-Path $desktop 'TransitSync Logs.lnk'
$l = $ws.CreateShortcut($logsLnk)
$l.TargetPath       = $logsDir
$l.WorkingDirectory = $root
$l.Description      = 'TransitSync logs: transitsync-console.log (live console) and server_activity.log.'
$l.WindowStyle      = 1
$l.Save()
$made += 'TransitSync Logs.lnk'

# --- retire the old name ---------------------------------------------------
$legacy = Join-Path $desktop 'TransitSync Server.lnk'
if (Test-Path $legacy) {
  Remove-Item -LiteralPath $legacy -Force
  Write-Output ('  [i] Retired old shortcut "TransitSync Server.lnk".')
}

Write-Output ''
Write-Output ("  [OK] Desktop shortcuts in {0}:" -f $desktop)
foreach ($n in $made) { Write-Output ("       - {0}" -f $n) }
