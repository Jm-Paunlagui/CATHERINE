# Restart and shutdown verification (once per host)

Proves on the real host that every kind of stop is handled and reported the
way the reliability test suite proves it on a development machine. About 20
minutes. Do it on the build machine or a staging server first, never in
business hours on production.

Before you start: notifications are on (`ENABLE_SERVER_NOTIFICATIONS=true`)
and you can read the alert mailbox. Each step names the email you should get
on the **next start**. The 15-minute throttle means a "Server started" notice
is skipped if one was sent less than 15 minutes earlier; a CRITICAL is never
skipped.

## 0. Automated check (any OS with Node)

```sh
npm run test:reliability     # includes test/server/reliability/graceful-shutdown.test.js; 0 failed
```

Every check must pass (0 failed) before the manual steps. The automated suite
does not exercise the Windows service stop path (SIGBREAK from WinSW) or a
clustered stop; the manual steps below do.

## Windows (WinSW)

Elevated PowerShell in `deploy\winsw`. Marker: `dist\data\server-run.json`.

| # | Do | Expect |
|---|----|--------|
| 1 | `.\check-shutdown-readiness.ps1` | Service Running, `Accepts SHUTDOWN True`, host-reboot window shown, marker `RUNNING` with this host's name |
| 2 | `Restart-Service catherine-backend` | Marker goes `STOPPED` (exit 0) then `RUNNING`; email: "Server started" NOTICE, "stopped cleanly (service stop)" (or skipped by the throttle) |
| 3 | `taskkill /F /IM catherine-backend.exe` (WinSW restarts it after 10 s) | Email: **CRITICAL "Server restarted without a clean shutdown"**, down under a minute |
| 4 | Wait 15 min, then **restart the host** (`Restart-Computer`) with nobody using the app | Expect CLEAN (NOTICE "stopped cleanly"). If you get the CRITICAL instead, the reboot window was too short: send the output of step 1 and `dist\service-logs\*.wrapper.log` |
| 5 | Start a long export in the app, then `Restart-Service catherine-backend` | The export finishes, then the service stops (the log shows "waiting for 1 in-flight request(s)"). While it waits, other pages show "The server is restarting…" and `GET /api/v1/health/ready` answers 503 with `draining: true` |
| 6 | Re-run `.\check-shutdown-readiness.ps1` | The event list shows 1074 / 6006 / 6005 for step 4 and 7031/7034 for step 3 (the 1074 line shows `on behalf of user <account>`: the account is left out on purpose: the report is often pasted into tickets) |

## Linux (systemd)

Marker: `<WorkingDirectory>/data/server-run.json`.

| # | Do | Expect |
|---|----|--------|
| 1 | `systemctl show -p TimeoutStopUSec,KillMode catherine-backend` | `31min`, `mixed` |
| 2 | `sudo systemctl restart catherine-backend` | Marker `STOPPED` (exit 0, `SIGTERM`) then `RUNNING`; `systemctl show -p Result` = `success`; NOTICE "stopped cleanly" (or throttled) |
| 3 | `sudo systemctl kill -s SIGKILL catherine-backend` (restarts after 10 s) | **CRITICAL "Server restarted without a clean shutdown"** |
| 4 | Wait 15 min, then `sudo reboot` | NOTICE "stopped cleanly" (systemd gives the unit its full 1860 s on reboot) |
| 5 | Long export, then `sudo systemctl stop catherine-backend` | `stop` returns only after the export finishes. While it waits, other pages show "The server is restarting…" and `GET /api/v1/health/ready` answers 503 with `draining: true` |

Steps 1-3 and 5 can be run in a systemd-enabled container; reboot (step 4)
needs a real host or VM.

## If something does not match

Keep the marker file, `dist\service-logs\` (Windows) or
`journalctl -u catherine-backend -b -1` (Linux), and the emails. Do not delete the
marker to "reset" it: that hides the next unclean restart.
