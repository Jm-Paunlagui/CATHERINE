# WinSW Service — CATHERINE Backend Auto-Start

Runs the compiled backend exe as a Windows service: starts automatically after
every server reboot (Automatic, Delayed Start) and restarts itself 10 seconds
after a crash.

## Prerequisites

1. Built exe + config in `Backend\dist\` — `catherine-backend.exe`, `.env`, `certs\` (when `USE_HTTPS=true`).
2. `WinSW-x64.exe` from <https://github.com/winsw/winsw/releases/tag/v2.12.0> (v2.12.0). Drop it into this folder (gitignored) — the install script finds it automatically.
3. A service account (`DOMAIN\user`) with read access to the dist folder and the Oracle Instant Client path from `.env`.

## Install (elevated PowerShell)

```powershell
cd D:\Web\CATHERINE\Backend\deploy\winsw
.\install-service.ps1   # finds WinSW-x64.exe in this folder automatically
# WinSW prompts for the service account credentials — they are never stored on disk.
# A copy elsewhere? Pass it explicitly: .\install-service.ps1 -WinSW C:\tools\WinSW-x64.exe
```

## Manage

```powershell
Get-Service catherine-backend          # status
Restart-Service catherine-backend
.\uninstall-service.ps1                # stop + remove
```

Wrapper stdout/stderr (banner, `[FATAL]` lines): `dist\service-logs\`.
Application logs: `dist\logs\YYYY\MM\DD\`.
