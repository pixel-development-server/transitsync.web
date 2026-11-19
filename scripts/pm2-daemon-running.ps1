# ===========================================================================
#  Prints "yes" if the PM2 daemon is currently running, otherwise nothing.
#
#  Used by start-transitsync-console.bat so it only asks PM2 to stop the old
#  API when PM2 is actually managing one. Invoking `pm2` when no daemon exists
#  would spawn a background PM2 daemon just to stop nothing — leaving a stray
#  node process behind, which defeats the "nothing runs in the background"
#  design of the live console.
# ===========================================================================

$daemon = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*pm2*Daemon.js*' }

if ($daemon) { 'yes' }
