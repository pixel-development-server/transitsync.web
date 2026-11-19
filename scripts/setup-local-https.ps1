<#
  setup-local-https.ps1  —  local trusted TLS for the TransitSync homelab.

  Built-in-Windows equivalent of:
      mkcert -install
      mkcert transitsync.me www.transitsync.me localhost 127.0.0.1 192.168.18.250
  followed by an IIS https/SNI binding, so https://transitsync.me works with
  NO browser warning on machines that trust the generated root CA.

  What it does:
    1. Creates (once) a local Root CA in LocalMachine\My and trusts it
       machine-wide by installing it into LocalMachine\Root.
    2. Issues a server cert (SAN = the given DNS names + IPs) signed by that CA.
    3. Binds it to the IIS 'TransitSync' site on :443 with SNI for each
       hostname, so IIS terminates TLS and ARR keeps proxying to Caddy :8080.
    4. Exports the Root CA to certs\transitsync-local-rootCA.crt so other
       devices (phones/tablets) can trust it too.

  Idempotent and safe to re-run. Must run as Administrator.
#>
[CmdletBinding()]
param(
  [string]$SiteName = 'TransitSync',
  [string[]]$DnsNames = @('transitsync.me', 'www.transitsync.me', 'localhost'),
  [string[]]$IpAddresses = @('127.0.0.1', '192.168.18.250'),
  [string]$ExportDir = 'C:\SYP\certs'
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration

$CaSubject = 'CN=TransitSync Local Dev Root CA'
$SrvSubject = 'CN=transitsync.me'

# --- 1) Root CA (create once, always ensure it is trusted) ------------------
$ca = Get-ChildItem Cert:\LocalMachine\My |
      Where-Object { $_.Subject -eq $CaSubject } |
      Sort-Object NotAfter -Descending | Select-Object -First 1

if (-not $ca) {
  Write-Host "[+] creating root CA: $CaSubject"
  $ca = New-SelfSignedCertificate -Type Custom -Subject $CaSubject `
        -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -KeyUsage CertSign, CRLSign, DigitalSignature -KeyExportPolicy Exportable `
        -CertStoreLocation 'Cert:\LocalMachine\My' `
        -TextExtension @('2.5.29.19={critical}{text}ca=true&pathlength=0')
} else {
  Write-Host "[=] reusing root CA: $($ca.Thumbprint)"
}

# Trust it machine-wide (idempotent: ignore "already exists").
$root = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
$root.Open('ReadWrite')
try { $root.Add($ca) } finally { $root.Close() }
Write-Host "[+] root CA trusted in LocalMachine\Root"

# --- 2) server cert signed by the CA ---------------------------------------
Write-Host "[+] issuing server cert for: $($DnsNames -join ', ')  ($($IpAddresses -join ', '))"
Get-ChildItem Cert:\LocalMachine\My |
  Where-Object { $_.Subject -eq $SrvSubject } |
  Remove-Item -Force -ErrorAction SilentlyContinue

# SAN (2.5.29.17) is supplied as extension text because this build's
# New-SelfSignedCertificate has no -IpAddress parameter.
$sanParts = @()
$sanParts += ($DnsNames    | ForEach-Object { "DNS=$_" })
$sanParts += ($IpAddresses | ForEach-Object { "IPAddress=$_" })
$sanText = '2.5.29.17={text}' + ($sanParts -join '&')

$cert = New-SelfSignedCertificate -Type Custom -Subject $SrvSubject `
        -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -KeyUsage DigitalSignature, KeyEncipherment -KeyExportPolicy Exportable `
        -CertStoreLocation 'Cert:\LocalMachine\My' -Signer $ca `
        -TextExtension @($sanText, '2.5.29.37={text}1.3.6.1.5.5.7.3.1')
Write-Host "[+] server cert thumbprint: $($cert.Thumbprint)"

# --- 3) IIS :443 SNI bindings ----------------------------------------------
foreach ($h in $DnsNames) {
  $bi = "*:443:$h"
  $exists = Get-WebBinding -Name $SiteName -ErrorAction SilentlyContinue |
            Where-Object { $_.bindingInformation -eq $bi }
  if (-not $exists) {
    New-WebBinding -Name $SiteName -Protocol https -Port 443 -HostHeader $h -SslFlags 1
    Write-Host "[+] added IIS binding $bi"
  } else {
    Write-Host "[=] IIS binding already present $bi"
  }

  # Bind the cert to this SNI endpoint (replace any stale binding).
  $sslPath = "IIS:\SslBindings\0.0.0.0!443!$h"
  if (Test-Path $sslPath) { Remove-Item $sslPath -Force }
  New-Item -Path $sslPath -Value $cert -SSLFlags 1 | Out-Null
  Write-Host "[+] bound cert to $sslPath"
}

# --- 4) export the CA for other devices ------------------------------------
New-Item -ItemType Directory -Force -Path $ExportDir | Out-Null
$caPath = Join-Path $ExportDir 'transitsync-local-rootCA.crt'
Export-Certificate -Cert $ca -FilePath $caPath -Type CERT | Out-Null
Write-Host "[+] exported root CA -> $caPath"

Write-Host ""
Write-Host "Done. Test:  Invoke-WebRequest https://transitsync.me/ -UseBasicParsing"
