# CATHERINE backend on Linux (systemd)

The template's primary target is Windows under WinSW (`deploy/winsw/`). This folder gives a
Linux host the same behaviour: start at boot, restart after a crash, and a
graceful stop that lets work in progress finish.

## Install

1. Check out the `Backend` folder (e.g. `/opt/catherine-backend`), run
   `npm ci --omit=dev`, and put the production `.env` beside `server.js`.
2. Create the service account:
   `sudo useradd --system --home /opt/catherine-backend catherine`, and give it
   ownership of `logs/`, `data/` and the backup directory (read-only is enough
   for the rest of the checkout).
3. Copy the unit and edit the lines marked `EDIT` (user, `WorkingDirectory`,
   `ExecStart`):

   ```sh
   sudo cp deploy/systemd/catherine-backend.service /etc/systemd/system/
   sudo systemd-analyze verify /etc/systemd/system/catherine-backend.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now catherine-backend
   ```

## How a stop works

| Event | What the server gets | Time allowed |
|---|---|---|
| `systemctl stop` / `restart` | SIGTERM to the main process | `TimeoutStopSec=1860` |
| Host reboot or poweroff | the same SIGTERM | the same 1860 s (a hypervisor or UPS may cut it short) |
| `kill -9`, OOM kill, power loss | nothing | none; reported on the next start |

On SIGTERM the server refuses new connections at once, lets requests that keep
making progress finish (cap 30 min), then closes the pools and flushes the
audit buffer. A stop with nothing in flight exits in about a second.

**Never lower `TimeoutStopSec` below 1860.** systemd's default (90 s) would
SIGKILL a long import or export partway. It must exceed `FORCED_EXIT_MS`
(1 834 s) + `CLUSTER_SHUTDOWN_MARGIN_MS` (10 s) + the forced-exit email
(<= 5.5 s) from `server.js`, and should stay equal to `<stoptimeout>` in
`deploy/winsw/catherine-backend-service.xml`.

`KillMode=mixed` sends SIGTERM to the main process only. With
`ENABLE_CLUSTERING=true` the primary forwards the stop to its workers; systemd
signalling them directly would race that.

## Restart tracking

The marker is `<WorkingDirectory>/data/server-run.json`. Do not delete it and
do not copy it between machines (a record from another host is ignored, so a
copy is harmless but useless). After any restart:

```sh
cat /opt/catherine-backend/data/server-run.json   # state RUNNING, pid = MainPID
systemctl show -p MainPID catherine-backend
journalctl -u catherine-backend -b -1 | tail      # how the previous boot ended
```

## Containers

Under Docker, give the container the same window and an init process:
`docker run --init --stop-timeout 1860 ...`, or in Compose
`init: true` and `stop_grace_period: 31m`. Without `--init` a shell PID 1 does
not reap exited processes.

## Verify

Follow `deploy/RESTART_VERIFICATION.md` once on the target host.
