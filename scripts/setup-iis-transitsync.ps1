# ===========================================================================
#  TransitSync -- IIS site provisioning (www.transitsync.iic.edu.np)
#
#  TransitSync is a Node/Express app (React SPA + REST API + SSE). IIS cannot
#  run it directly, so this script points an IIS site at the Node backend by
#  installing the two Microsoft modules that enable reverse proxying:
#
#    * IIS URL Rewrite 2.1
#    * Application Request Routing 3.0 (ARR)
#
#  Then it creates an app pool + site bound to the requested host name and a
#  web.config that forwards every request to http://127.0.0.1:8080.
#
#  Run once, as Administrator:
#    powershell -ExecutionPolicy Bypass -File C:\SYP\scripts\setup-iis-transitsync.ps1
# ===========================================================================

$ErrorActionPreference = 'Stop'

$siteName = 'TransitSync'
$hostName = 'www.transitsync.iic.edu.np'
$port     = 80
$sitePath = 'C:\inetpub\TransitSync'
$backend  = 'http://127.0.0.1:8080'
$tmp      = 'C:\Users\Administrator\AppData\Local\Temp\2\opencode'
$appcmd   = "$env:windir\system32\inetsrv\appcmd.exe"

function Write-Step($msg) { Write-Host ("`n== {0}" -f $msg) -ForegroundColor Cyan }

if (-not (Test-Path $tmp)) { New-Item -ItemType Directory -Force -Path $tmp | Out-Null }

# --- 1. IIS URL Rewrite ----------------------------------------------------
Write-Step 'Installing IIS URL Rewrite 2.1 (if missing)'
if (-not (Test-Path 'C:\Windows\System32\inetsrv\rewrite.dll')) {
  $msi = Join-Path $tmp 'rewrite_amd64_en-US.msi'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi' -OutFile $msi
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  if (-not (Test-Path 'C:\Windows\System32\inetsrv\rewrite.dll')) { throw 'URL Rewrite install failed.' }
} else { Write-Host '   already installed.' }

# --- 2. Application Request Routing (ARR) ----------------------------------
Write-Step 'Installing Application Request Routing 3.0 (if missing)'
if (-not (Test-Path 'C:\Program Files\IIS\Application Request Routing')) {
  $msi = Join-Path $tmp 'requestRouter_amd64.msi'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi' -OutFile $msi
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  if (-not (Test-Path 'C:\Program Files\IIS\Application Request Routing')) { throw 'ARR install failed.' }
} else { Write-Host '   already installed.' }

# --- 3. Turn the ARR proxy on (server-wide) --------------------------------
Write-Step 'Enabling the ARR proxy'
& $appcmd set config -section:system.webServer/proxy -enabled:true /commit:apphost | Out-Null
# Do not buffer responses: TransitSync streams live scan events over SSE.
& $appcmd set config -section:system.webServer/proxy -responseBufferThreshold:0 /commit:apphost 2>$null | Out-Null
& $appcmd set config -section:system.webServer/proxy -preserveHostHeader:true /commit:apphost | Out-Null

# --- 4. Content folder + reverse-proxy web.config --------------------------
Write-Step "Writing site folder $sitePath"
New-Item -ItemType Directory -Force -Path $sitePath | Out-Null
$webConfig = @"
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="TransitSync reverse proxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="$backend/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
"@
Set-Content -LiteralPath (Join-Path $sitePath 'web.config') -Value $webConfig -Encoding ascii

# --- 5. App pool -----------------------------------------------------------
Write-Step "Ensuring app pool '$siteName'"
$poolExists = & $appcmd list apppool "$siteName" 2>$null
if (-not $poolExists) {
  & $appcmd add apppool /name:"$siteName" /managedRuntimeVersion:"" | Out-Null
}

# --- 6. Site + binding -----------------------------------------------------
Write-Step "Ensuring site '$siteName' bound to $hostName :$port"
$siteExists = & $appcmd list site "$siteName" 2>$null
if ($siteExists) {
  & $appcmd set site /site.name:"$siteName" /bindings:"http/*:${port}:$hostName" | Out-Null
  & $appcmd set app "$siteName/" /physicalPath:"$sitePath" | Out-Null
  & $appcmd set app "$siteName/" /applicationPool:"$siteName" | Out-Null
} else {
  & $appcmd add site /name:"$siteName" /bindings:"http/*:${port}:$hostName" /physicalPath:"$sitePath" | Out-Null
  & $appcmd set app "$siteName/" /applicationPool:"$siteName" | Out-Null
}

Write-Host "`nDone. IIS site '$siteName' -> $backend (host header $hostName)." -ForegroundColor Green
