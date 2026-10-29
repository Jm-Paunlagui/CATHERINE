# CATHERINE Backend — Production Deployment Runbook

Backend: PKG-compiled `catherine-backend.exe` as a WinSW Windows service (HTTPS, PFX read
by the exe). Frontend: Vite build copied to an IIS site root (HTTPS terminated
at IIS). Topology: same hostname, different port — FE `https://SERVER/`, BE
`https://SERVER:3000`. Auth cookies are `SameSite=Strict` and survive the
cross-port split because SameSite ignores ports; a **different hostname** for
the API would silently drop them — keep both on one hostname (or revisit the
cookie policy first).

---

## A. One-time / per-release database steps

1. **Fresh schema:** apply the `sql/` scripts in numeric order
   (`01_schema.sql`, then the rest). `02_seed_demo.sql` is demo data — skip it
   in production unless you want the demo rows.
2. **Upgrade:** apply only the scripts and project migrations added since the
   deployed release, in numeric order, **before** deploying the code that reads
   the new columns (models use explicit projections, so code ahead of schema
   fails with `ORA-00904`).
3. Record per release whether it has a database step. "No database step" is a
   statement worth writing down — it tells the operator nothing was forgotten.
4. Behind a reverse proxy (IIS ARR or nginx), set the proxy read timeout to
   **at least 300 s** for any long-running endpoint (bulk re-sign, export,
   backup/restore). A shorter proxy timeout cuts the request while the server
   is still working.

## B. Backend build (on the build machine)

1. `npm ci --include=dev` — the PKG builder (`@yao-pkg/pkg`, pinned in
   devDependencies) installs locally; no global `pkg` needed.
2. `npm run build` → `dist\catherine-backend.exe` + `dist\node_modules\{oracledb,argon2}`
   native addons. **The postbuild step fails the build (exit 1) if any native
   stages zero files** — never deploy a dist folder from a failed build.
3. Stage alongside the exe: `.env` (see C), `data\changelog.enc` (from the
   repo — preserves changelog history), `certs\` (see C).
   **Do NOT stage `data\server-run.json` from the build machine, and never
   delete it on the server** (restart tracking: deleting it skips one
   unclean-restart check; copying a dev file would fake a previous run). The
   service creates and maintains it in `dist\data\`.
4. Smoke-run the exe once interactively (`.\catherine-backend.exe`): expect
   "Native-module preflight: argon2 loaded successfully." and
   "Server listening on …"; no ALERT lines.
   **Then delete `dist\data\server-run.json` before packaging** (the smoke run
   leaves a RUNNING record from the build machine), and exclude that file (and
   `server-run.json.*.tmp`) from the package. A record from another host is
   ignored on the server's first boot (treated as a first start), but it must
   not ship anyway.

## C. Backend `dist\.env` checklist

- **Six bootGuard secrets** — each ≥32 chars, non-placeholder, or the service
  exits immediately (→ WinSW 10 s restart loop): `JWT_SECRET`, `CSRF_SECRET`,
  `COOKIE_SECRET`, `ARGON2_PEPPER`, `DATA_SIGNING_SECRET`,
  `CHANGELOG_ENCRYPTION_KEY`. Also `DEMO_MODE=false`, `NODE_ENV=production`.
- **HTTPS**: `USE_HTTPS=true`, `PFX_FILENAME` (default `server.pfx`) present in
  `certs\`, `PFX_PASSPHRASE` set. Missing/expired PFX = startup failure =
  restart loop; **track the certificate's expiry date** — renewal is: replace
  PFX, `Restart-Service catherine-backend`. Clients must trust the `:3000` cert
  (domain/internal CA): an untrusted API cert fails every XHR **silently** (no
  browser interstitial for XHR, unlike page navigations).
- **SMTP internal CA**: `SMTP_CA_FILE=<internal-root>.pem` + the PEM in
  `certs\` — required even with HTTPS off (independent trust stores). Unset ⇒
  system CA bundle; unreadable file ⇒ logged warning + system CA fallback.
- `ORACLE_INSTANT_CLIENT` path exists and is readable by the service account.
- **`ENABLE_CLUSTERING`**: decide and record it per host. With `true`,
  `NUM_WORKERS` worker processes run under the service's
  `catherine-backend.exe` (the primary). Consequences to keep in mind:
  - Each worker has its own pools, so Oracle sessions reach about
    `NUM_WORKERS × (APP_POOL_MAX + APP_BULK_POOL_MAX)` (e.g. 4 × (10 + 6) = 64
    with the `.env.example` values). Check that against the schema's
    SESSIONS/PROCESSES limits before raising `NUM_WORKERS` or a pool size.
  - `RATE_LIMIT_MAX` and the login lockout are counted across ALL workers.
  - Restart tracking: only the cron-leader worker writes
    `data\server-run.json`; its PID is a worker's, not the primary's.
  - The Windows stop path of a cluster is NOT covered by the automated
    tests. Verify it with
    `deploy/RESTART_VERIFICATION.md`; `deploy/winsw/check-shutdown-readiness.ps1`
    shows the primary, the workers and the marker writer.
- **`APP_TZ`** (default `Asia/Manila`) must be the zone the database's
  wall-clock values are written in. `server.js` pins the process time zone to
  it before the first `Date` is built, and the daily cron runs on that local
  clock — node-cron's own `timezone` option is not used because PKG's
  small-ICU build can silently break its resolution (the tick never fires, no
  error). Exact-time timers are epoch-based and unaffected, but a wrong
  `APP_TZ` shifts the daily jobs' wall-clock time.

## D. Windows service (WinSW)

Follow [`deploy/winsw/README.md`](winsw/README.md) — including its
**Verify after install** section (boot preflight lines + graceful-stop banner
on `Stop-Service`). The service account needs **Read & execute** on dist and
**Modify only** on the folders written at runtime (`logs\`, `data\`,
`service-logs\`, `DB_BACKUP_DIR`) — never Modify on dist itself (CWE-732, see
the README's ACL example); never deploy under `C:\Program Files`.

## E. Frontend build + IIS

1. Set `VITE_API_BASE_URL=https://<SERVER>:3000/api/v1/` in `.env.production`
   **before** `npm run build`. The build now **fails** when the variable is
   unset in production mode, and also fails on a plain `http://` value (an
   HTTPS-served page cannot call an HTTP API — browsers block it as mixed
   content). Deliberate plain-HTTP test builds: set
   `VITE_ALLOW_INSECURE_API=true`.
2. `VITE_SESSION_TIMEOUT_MS` must match the backend `JWT_EXPIRES_IN`, or the
   session-warning modal desynchronises from real token expiry.
3. Leave `VITE_ENV` unset (or `production`) — `development` suppresses
   sign-out flows meant only for local work.
4. Copy `dist\` to the IIS **site root** (vite `base:"/"`; a sub-application
   would 404 every `/assets/…` request). Confirm `Web.config` is present in
   the copied output — it ships from `public/` and carries the SPA rewrite,
   caching, and security headers.
5. IIS prerequisites: **URL Rewrite module installed** (else the site throws
   `500.19` on the `<rewrite>` section) and an **HTTPS binding** with the
   server certificate.

## F. Known limits (documented, intentionally not "fixed")

- **First start on a host:** there is no restart marker yet, so the first boot
  sends a "Server started" NOTICE with "previous run unknown" and raises no
  unclean-restart alarm; and any alert finding that is still open is
  **re-emailed ONCE**, because no persisted alert state exists yet. Later
  restarts do not repeat it.
- Rotating `DATA_SIGNING_SECRET` changes every alert signature and re-emails
  each open alert finding once.
- A scheduled job whose idempotency claim is taken *before* dispatch fails
  closed on a crash between the two: the automatic retry is suppressed (no
  duplicate send); the ERROR/ALERT trail in `logs\` identifies it, and a
  manual run covers it.
