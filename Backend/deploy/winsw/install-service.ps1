<#
.SYNOPSIS
  Installs the CATHERINE backend exe as a Windows service via WinSW.

.DESCRIPTION
  Copies the WinSW wrapper + the service XML template into the dist folder
  (so %BASE% = dist and every runtime path resolves next to the exe), then
  runs `<wrapper> install` — WinSW prompts on the console for the service
  account's credentials (nothing is stored in the XML) — and starts the
  service. Must be run from an ELEVATED PowerShell.

.PARAMETER WinSW
  Path to WinSW-x64.exe (download: https://github.com/winsw/winsw/releases/tag/v2.12.0,
  v2.12.0 recommended). Defaults to WinSW-x64.exe in this folder — drop the
  binary here and omit the parameter. Never committed (gitignored).

.PARAMETER DistDir
  Folder containing the compiled backend exe + .env + certs. Default: the
  repo's Backend\dist next to this script.

.PARAMETER ExeName
  Backend executable filename inside DistDir. Default: catherine-backend.exe

.EXAMPLE
  .\install-service.ps1 -WinSW C:\tools\WinSW-x64.exe
#>
param(
    [string]$WinSW = (Join-Path $PSScriptRoot "WinSW-x64.exe"),
    [string]$DistDir = (Join-Path $PSScriptRoot "..\..\dist"),
    [string]$ExeName = "catherine-backend.exe"
)

$ErrorActionPreference = "Stop"
$serviceId = "catherine-backend"

# ── Elevation check ──────────────────────────────────────────────────────────
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an ELEVATED PowerShell (service installation requires admin)."
}

# ── Validate inputs ──────────────────────────────────────────────────────────
$DistDir = (Resolve-Path $DistDir).Path
$backendExe = Join-Path $DistDir $ExeName
if (-not (Test-Path $WinSW)) {
    throw "WinSW binary not found: $WinSW`nDownload WinSW-x64.exe from https://github.com/winsw/winsw/releases/tag/v2.12.0 and pass its path via -WinSW."
}
if (-not (Test-Path $backendExe)) {
    throw "Backend exe not found: $backendExe`nBuild it first (npm run build) or pass -DistDir/-ExeName."
}
if (-not (Test-Path (Join-Path $DistDir ".env"))) {
    Write-Warning "No .env found in $DistDir — the backend reads its config from a .env NEXT TO THE EXE. Place one there before starting the service."
}
if (Get-Service -Name $serviceId -ErrorAction SilentlyContinue) {
    throw "Service '$serviceId' already exists. Run uninstall-service.ps1 first."
}

# ── Stage wrapper + config into dist (%BASE% = dist) ─────────────────────────
$wrapperExe = Join-Path $DistDir "$serviceId-service.exe"
$wrapperXml = Join-Path $DistDir "$serviceId-service.xml"
Copy-Item $WinSW $wrapperExe -Force
Copy-Item (Join-Path $PSScriptRoot "$serviceId-service.xml") $wrapperXml -Force

# Patch the executable name into the staged XML when a non-default exe name is used.
if ($ExeName -ne "catherine-backend.exe") {
    (Get-Content $wrapperXml -Raw) -replace "catherine-backend\.exe", $ExeName | Set-Content $wrapperXml -Encoding utf8
}

# ── Install (WinSW prompts for the service account credentials) + start ─────
Write-Host "Installing service '$serviceId' — WinSW will prompt for the service account (DOMAIN\user) and password..." -ForegroundColor Cyan
& $wrapperExe install
if ($LASTEXITCODE -ne 0) { throw "WinSW install failed (exit $LASTEXITCODE)." }

& $wrapperExe start
if ($LASTEXITCODE -ne 0) { throw "Service installed but failed to start (exit $LASTEXITCODE). Check $DistDir\service-logs\ and dist\logs\." }

Write-Host ""
Get-Service -Name $serviceId | Format-List Name, DisplayName, Status, StartType
Write-Host "Wrapper logs : $DistDir\service-logs\" -ForegroundColor DarkGray
Write-Host "App logs     : $DistDir\logs\" -ForegroundColor DarkGray
Write-Host "Startup type is Automatic (Delayed Start) — the backend starts on every server reboot and restarts 10s after a crash." -ForegroundColor Green
