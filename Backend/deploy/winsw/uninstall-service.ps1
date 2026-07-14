<#
.SYNOPSIS
  Stops and removes the CATHERINE backend Windows service and its staged
  WinSW wrapper files. Run from an ELEVATED PowerShell.

.PARAMETER DistDir
  Folder the service was installed from. Default: the repo's Backend\dist.
#>
param(
    [string]$DistDir = (Join-Path $PSScriptRoot "..\..\dist")
)

$ErrorActionPreference = "Stop"
$serviceId = "catherine-backend"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an ELEVATED PowerShell."
}

$DistDir = (Resolve-Path $DistDir).Path
$wrapperExe = Join-Path $DistDir "$serviceId-service.exe"

if (Test-Path $wrapperExe) {
    & $wrapperExe stop 2>$null
    & $wrapperExe uninstall
    if ($LASTEXITCODE -ne 0) { Write-Warning "WinSW uninstall exited $LASTEXITCODE." }
} elseif (Get-Service -Name $serviceId -ErrorAction SilentlyContinue) {
    Stop-Service -Name $serviceId -Force -ErrorAction SilentlyContinue
    sc.exe delete $serviceId | Out-Null
}

Remove-Item (Join-Path $DistDir "$serviceId-service.exe") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $DistDir "$serviceId-service.xml") -Force -ErrorAction SilentlyContinue
Write-Host "Service '$serviceId' removed." -ForegroundColor Green
