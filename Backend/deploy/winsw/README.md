# WinSW Service — CATHERINE Backend Auto-Start

Runs the compiled backend exe as a Windows service: starts automatically after
every server reboot (Automatic, Delayed Start) and restarts itself 10 seconds
after a crash.

> Full end-to-end deployment steps (DB migration, secrets, FE build, smoke
> checks): see [`deploy/DEPLOYMENT_RUNBOOK.md`](../DEPLOYMENT_RUNBOOK.md).

## Prerequisites

1. Everything the exe reads/writes lives **next to it** in `Backend\dist\`:

    | Item                              | Required | Notes                                                                                                                              |
    | --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
    | `catherine-backend.exe`           | always   | `npm run build` output.                                                                                                            |
    | `.env`                            | always   | All six bootGuard secrets set (≥32 chars, non-placeholder) or the service exits → 10 s restart loop. `DEMO_MODE=false`.            |
    | `node_modules\oracledb\...`       | always   | Native addons staged by the build's postbuild step (fails the build if missing). Verify `oracledb` + `argon2` folders exist.       |
    | `node_modules\argon2\prebuilds\`  | always   | Same postbuild step. A boot-time preflight logs an ALERT if argon2 cannot load.                                                    |
    | `data\changelog.enc`              | always   | Copy from the repo — the app auto-creates an EMPTY store if absent and the committed changelog history is silently lost.           |
    | `certs\<PFX_FILENAME>`            | HTTPS    | `USE_HTTPS=true` (production). Missing/expired PFX fails startup → restart loop. Track expiry.                                     |
    | `certs\<SMTP_CA_FILE>`            | int. CA  | Needed when SMTP presents an internal-CA cert (e.g. `internal-root.pem`) — **independent of `USE_HTTPS`**. Missing → system CAs.   |
    | Oracle Instant Client (from .env) | always   | `ORACLE_INSTANT_CLIENT` path readable by the service account.                                                                      |

2. `WinSW-x64.exe` from <https://github.com/winsw/winsw/releases/tag/v2.12.0> (v2.12.0). Drop it into this folder (gitignored) — the install script finds it automatically.
3. A service account (`DOMAIN\user`) with **Read & execute** on the dist folder and **Modify only on the folders it writes**: `logs\`, `data\` (restart marker, changelog), `service-logs\` (WinSW) and the backup folder (`DB_BACKUP_DIR`), plus read access to the Oracle Instant Client path from `.env`. Do **not** give it Modify on dist itself: it could then replace `catherine-backend.exe` or `catherine-backend-service.exe`, which an administrator later runs elevated (uninstall), an escalation to admin (CWE-732/CWE-269). The same applies to this `deploy\winsw` folder. Example (adjust the account and paths; existing installs: re-check the ACL):

   ```powershell
   icacls D:\Apps\CATHERINE\Backend\dist /inheritance:r /grant "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "DOMAIN\svc-catherine:(OI)(CI)RX"
   foreach ($d in "logs","data","service-logs") { icacls "D:\Apps\CATHERINE\Backend\dist\$d" /grant "DOMAIN\svc-catherine:(OI)(CI)M" }
   icacls D:\Apps\CATHERINE\Backend\deploy\winsw /inheritance:r /grant "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "DOMAIN\svc-catherine:(OI)(CI)RX"
   ```

   If `DB_BACKUP_DIR` points outside `dist\`, grant the account Modify on that folder too.

   Do **not** deploy dist under `C:\Program Files` (not writable for non-admin accounts).

## Install (elevated PowerShell)

```powershell
cd D:\Apps\CATHERINE\Backend\deploy\winsw
.\install-service.ps1   # finds WinSW-x64.exe in this folder automatically
# WinSW prompts for the service account credentials — they are never stored on disk.
# A copy elsewhere? Pass it explicitly: .\install-service.ps1 -WinSW C:\tools\WinSW-x64.exe
```

## Verify after install

```powershell
Start-Service catherine-backend
# 1. Boot: dist\logs\ shows "Native-module preflight: argon2 loaded successfully."
#    and "Server listening on https://..."; no ALERT line from the preflight.
Stop-Service catherine-backend
# 2. Graceful stop: the log shows the shutdown banner ("SIGINT received —
#    shutting down gracefully…" / "SIGBREAK received — …" → pool close + audit flush). If it does NOT appear,
#    the stop was a hard kill — buffered audit rows from the final seconds
#    are lost on every stop/reboot; investigate before going live.
# 3. Restart tracking: after Stop-Service, dist\data\server-run.json shows
#    "state":"STOPPED" (exit code 0). After the next Start-Service, a
#    "Server started" NOTICE email arrives (when ENABLE_SERVER_NOTIFICATIONS=true).
#    The NOTICE is throttled to one per 15 min: a second restart inside that
#    window sends none (a CRITICAL is never throttled).
#    A host reset / kill leaves "RUNNING" or "STOPPING" instead, and the next
#    start emails "Server restarted without a clean shutdown" (CRITICAL).
#    Never delete or copy this file.
```

## Stop window (1860 s)

`<stoptimeout>` in `catherine-backend-service.xml` is **1860 sec**. The backend
refuses new requests at once, then lets requests already in progress finish
for as long as they keep making progress (absolute cap 30 min; a request idle
past its limit is cut much sooner by the request watchdog). Then pool close and
audit flush. A stop with nothing in flight still exits in about a second, but a
Windows "Stop" can legitimately take up to ~31 minutes while a long import or
export finishes. The log shows a "still waiting for N in-flight request(s)"
notice every minute during the wait.

The value must exceed `FORCED_EXIT_MS_DEFAULT` + `CLUSTER_SHUTDOWN_MARGIN_MS` +
5.5 s in `server.js` (1 834 s + 10 s + 5.5 s = 1 849.5 s < 1 860 s; see the
THE INVARIANTS comment block above those constants). An already-installed
service keeps its old window: **re-run `install-service.ps1`** after changing
`<stoptimeout>`, or Windows will force-kill the service at the old timeout
(earlier template revisions shipped 20 s).

## Host shutdown (preshutdown window)

`catherine-backend-service.xml` also sets `<preshutdown>true</preshutdown>` and
`<preshutdownTimeout>5 min</preshutdownTimeout>`. These make Windows send the
service a *preshutdown* notice when the **host** shuts down or reboots, and wait
up to that long for the service to stop (instead of the `WaitToKillServiceTimeout`
window a plain shutdown gives).

- **What v2.12.0 (pinned, latest stable) actually does on a host reboot.**
  It has no `preshutdown` support, so the two elements are silently ignored.
  But it DOES accept the plain shutdown control (`CanShutdown = true`;
  `OnShutdown()` runs the same stop as `Stop-Service`: a console Ctrl event,
  then a wait with wait hints). Windows then waits up to the machine-wide
  `WaitToKillServiceTimeout` (HKLM\SYSTEM\CurrentControlSet\Control, ms;
  Microsoft documents about 20 s by default) before continuing the shutdown.
  A quiet backend stops in about a second, so a reboot with nothing in flight
  should read CLEAN; only a request still running when that window ends is cut
  and reported UNCLEAN on the next start. **Measure it once** with
  `deploy/RESTART_VERIFICATION.md`; `check-shutdown-readiness.ps1` shows the
  window in effect.
- **On a host whose registry is centrally managed (e.g. by corporate IT):**
  keep v2.12.0, run `Stop-Service catherine-backend` before planned maintenance
  (it gets the full 1860 s), and accept that a reboot with work in flight is
  reported UNCLEAN (correct, and data-safe: uncommitted transactions roll back).
  If a quiet stop measures above ~4 s, shorten the app's own quiet stop instead.
- **Options for a longer host-reboot window** (ops decision, nothing changed here):
  1. Keep v2.12.0 (recommended): stable, and enough for a quiet server.
  2. **Only where you own the registry:** raise `WaitToKillServiceTimeout`:
     machine-wide, so every reboot may wait that long for slow services, and
     Microsoft advises services not to change it themselves; an administrator
     may. Some hosts ship a value as low as 5000 ms, and a clustered stop
     (primary + N workers) takes longer than a single process, so measure first:

     ```powershell
     Measure-Command { Stop-Service catherine-backend } | Select TotalSeconds
     Start-Service catherine-backend
     ```

     If a quiet stop takes more than about 4 s, raise it (elevated; the value is
     a STRING in milliseconds):

     ```powershell
     reg query HKLM\SYSTEM\CurrentControlSet\Control /v WaitToKillServiceTimeout   # note the old value
     reg add   HKLM\SYSTEM\CurrentControlSet\Control /v WaitToKillServiceTimeout /t REG_SZ /d 30000 /f
     ```

     Treat it as taking effect from the next reboot, then confirm with
     `check-shutdown-readiness.ps1` and step 4 of `deploy/RESTART_VERIFICATION.md`.
     To undo, `reg add` the old value back. 30 s covers a clustered stop with
     nothing in flight plus the shutdown email; it does not cover a long
     import/export, which a reboot still cuts (the transaction rolls back).
  3. WinSW v3 for the 5 min preshutdown window: still `v3.0.0-alpha.11`
     (January 2023, no release since). Not recommended in front of
     production data without a soak test; re-run this check afterwards
     (`ACCEPTS_PRESHUTDOWN` must show `True`).
- **Windows limits.** The window is `SERVICE_PRESHUTDOWN_INFO`: default 10 s
  since Windows 10 build 15063 / Server 2016 (3 min before). Microsoft documents
  no maximum, but the host (hypervisor, UPS, Group Policy, Windows Update) may
  cut a long shutdown sooner. 5 min is deliberate: it covers the default 120 s
  request idle window plus pool close.
- **What a host reboot means for requests.** The service gets the preshutdown
  window only, NOT the 1860 s stop window. A long import/export still running
  when it ends is cut (the DB transaction rolls back). Plain `Stop-Service` /
  `Restart-Service` still gets the full 1860 s.
- **Audit rows.** Buffered audit rows are flushed at the START of the stop
  (non-final flush, detached), before the request wait, so a mid-wait kill does
  not lose them. The final flush at teardown still runs.

## Manage

```powershell
Get-Service catherine-backend          # status
Restart-Service catherine-backend
.\uninstall-service.ps1                # stop + remove
.\check-shutdown-readiness.ps1         # READ-ONLY: stop/reboot windows, marker, recent restart events
```

Wrapper stdout/stderr (banner, `[FATAL]` lines): `dist\service-logs\`.
Application logs: `dist\logs\YYYY\MM\DD\`.
