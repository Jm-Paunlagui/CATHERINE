# CATHERINE Production Deployment Runbook

Backend: PKG-compiled `backend.exe` run as a WinSW Windows service (HTTPS, PFX
read by the exe). Frontend: Vite build copied to an IIS site root (HTTPS
terminated at IIS). Topology: same hostname, different port — FE
`https://SERVER/`, BE `https://SERVER:3000`. Auth cookies are `SameSite=Strict`
and survive the cross-port split because SameSite ignores ports; a **different
hostname** for the API would silently drop them — keep both on one hostname (or
revisit the cookie policy first).

> This is a **template** runbook. CATHERINE ships capability, not a product, so
> there is no business-domain migration or scheduled-job step here. When a copier
> builds a real domain on top of the template, add its own database and job steps
> to sections A and F.

---

## A. One-time / per-release database steps

CATHERINE runs with **zero database** when `DEMO_MODE=true` (all fixtures are
in-memory). For a real deployment:

1. Apply `sql/01_schema.sql` once against an empty schema, then `sql/02_seed_demo.sql`
   if you want the demo data. Apply any newer files in `sql/` in numeric order.
2. **Money (only if you build a money domain):** create the ledger and FX tables
   from the commented reference DDL in `sql/README.md` (`T_FX_RATE_DEV`,
   `T_LEDGER_DEV`, `T_MONEY_BASE_EPOCH_DEV`), then set `MONEY_BASE_CURRENCY`,
   `MONEY_FX_TABLE`, and `MONEY_LEDGER_TABLES` in `.env`. With none of these set,
   the money boot-guard is a no-op and the FX service is inert (503 on lookup) —
   the template boots fine without any money tables.

## B. Backend build (on the build machine)

1. `npm ci --include=dev` — the PKG builder (`@yao-pkg/pkg`, pinned in
   devDependencies) installs locally; no global `pkg` needed.
2. `npm run build` → `dist\backend.exe` + `dist\node_modules\{oracledb,argon2}`
   native addons. **The postbuild step (`scripts/postbuild-copy-natives.js`)
   fails the build (exit 1) if any native stages zero files** — never deploy a
   dist folder from a failed build.
3. Stage alongside the exe: `.env` (see C), `data\changelog.enc` (from the repo —
   preserves changelog history), `certs\` (see C).
4. Smoke-run the exe once interactively (`.\backend.exe`): expect
   "Native-module preflight: argon2 loaded successfully" and
   "Server startup complete"; no ALERT lines.

## C. Backend `dist\.env` checklist

- **Six bootGuard secrets** — each ≥32 chars, non-placeholder, or the service
  exits immediately (→ WinSW restart loop): `JWT_SECRET`, `CSRF_SECRET`,
  `COOKIE_SECRET`, `ARGON2_PEPPER`, `DATA_SIGNING_SECRET`,
  `CHANGELOG_ENCRYPTION_KEY`. Also `DEMO_MODE=false`, `NODE_ENV=production`,
  and a non-empty `CORS_ORIGINS`.
- **HTTPS**: `USE_HTTPS=true`, `PFX_FILENAME` (default `server.pfx`) present in
  `certs\`, `PFX_PASSPHRASE` set. Missing/expired PFX = startup failure =
  restart loop; **track the certificate's expiry date** — renewal is: replace
  PFX, `Restart-Service catherine-backend`. Clients must trust the `:3000` cert
  (domain/internal CA): an untrusted API cert fails every XHR **silently** (no
  browser interstitial for XHR, unlike page navigations).
- **SMTP internal CA** (only if `ENABLE_SERVER_NOTIFICATIONS=true` or you send
  mail): `SMTP_CA_FILE` + the PEM in `certs\` — required even with HTTPS off
  (independent trust stores). Unset ⇒ system CA bundle; unreadable file ⇒ logged
  warning + system CA fallback.
- `ORACLE_INSTANT_CLIENT` path exists and is readable by the service account
  (skip entirely when `DEMO_MODE=true`).
- `ENABLE_CLUSTERING=false` (default) — clustering under PKG/WinSW is
  unverified; do not enable it in this deployment without testing. If you do
  enable it, note the leader election: the primary stamps exactly one worker
  `CRON_LEADER=true` (never set it by hand — see `.env.example`).
- **Server OS timezone.** All scheduled work uses plain `setInterval`, never
  node-cron (PKG's small-ICU build silently broke cron timezone resolution), so
  the OS local clock is what matters. For money workloads pin `TZ=UTC` (a REAL
  OS env var, set before launch) so a rate's effective window and a ledger
  posting date never shift under a server relocation. Keep
  `DB_TIMEZONE_OFFSET_MINUTES` aligned with the Oracle instance — it is
  load-bearing for row-hash (SYSSIGNATURE) verification.

## D. Windows service (WinSW)

Follow [`deploy/winsw/README.md`](winsw/README.md) — including its
**Verify after install** section (boot preflight lines + graceful-stop banner
on `Stop-Service`). Service account needs **Modify** rights on dist (`logs\`,
`data\` are written at runtime); never deploy under `C:\Program Files`.

## E. Frontend build + IIS

1. Set `VITE_API_BASE_URL=https://<SERVER>:3000/api/v1/` in `.env.production`
   **before** `npm run build`. The build **fails** when the variable is unset in
   production mode, and also fails on a plain `http://` value (an HTTPS-served
   page cannot call an HTTP API — browsers block it as mixed content).
   Deliberate plain-HTTP test builds: set `VITE_ALLOW_INSECURE_API=true`.
2. `VITE_SESSION_TIMEOUT_MS` must match the backend `JWT_EXPIRES_IN`, or the
   session-warning modal desynchronises from real token expiry.
3. Leave `VITE_ENV` unset (or `production`) — `development` suppresses
   sign-out flows meant only for local work.
4. Copy `dist\` to the IIS **site root** (vite `base:"/"`; a sub-application
   would 404 every `/assets/…` request). Confirm `Web.config` is present in the
   copied output — it ships from `public/` and carries the SPA rewrite, caching,
   and security headers (HSTS + CSP with the `__CSP_CONNECT_SRC__` placeholder
   substituted at build time to the API origin).
5. IIS prerequisites: **URL Rewrite module installed** (else the site throws
   `500.19` on the `<rewrite>` section) and an **HTTPS binding** with the server
   certificate.

## F. Known limits (documented, intentionally not "fixed")

- The audit-log storage defaults to `auto`: Oracle first, then a permanent
  per-process switch to the JSON-lines file fallback on the first write failure.
  A missing audit table therefore does not crash the app — it silently falls
  back to files under `logs\`. Confirm the table exists in production if you
  require DB-persisted audit trails.
- Rate limits and the login-lockout store are **per worker / in-memory**. Under
  clustering the effective global limit is ≈ `NUM_WORKERS × RATE_LIMIT_MAX`;
  a process restart clears lockout state.
- The money FX service ships **manual entry only** — provider integration is a
  documented adapter, not code (see `sql/README.md` and `FxRateService`). A
  base-currency change is a prospective epoch (IAS 21); the boot-guard refuses an
  in-place change once ledger tables exist unless `MONEY_BASE_CURRENCY_MIGRATION=true`.
