# CATHERINE Backend

The API half of **CATHERINE**, a generic full-stack template: Node.js + Express 5 + Oracle, with a React client in [`../Frontend`](../Frontend). It ships the platform plumbing a business app needs (auth, roles, audit, observability, integrity, backups, graceful shutdown) and leaves an empty slot for project feature routes.

Package: `catherine-backend` `1.0.0-dev.46`, kept in lockstep with the frontend.

## What it does

| Area | Highlights |
| --- | --- |
| **Auth** | JWT access + refresh cookies (`app.access-token`, `app.refresh-token`), refresh rotation with reuse detection, forced password change, login lockout, four auth rate limiters |
| **Roles** | `SUPER_ADMIN`, `ADMIN`, `USER`. Admin management with server-generated temporary passwords (72 h), last-super-admin guard |
| **Audit and logs** | Request IDs on every request, audit log (DB, file or auto), system logs, SSE streams, Excel and log exports |
| **Observability** | Health/liveness/readiness probes, per-route metrics (p50/p95/p99), alerts with acknowledgement, email notifications |
| **Integrity** | HMAC `ROW_HASH` row signing, tamper scan, browse and export per table |
| **Data purge and backups** | Scoped purge with preview, backup token, authorise/execute, restore, scheduled backups and two-person delete votes |
| **Support pages** | Changelog (encrypted store), dev-docs viewer, architecture and runtime system maps |
| **Money** | Decimal-safe money utilities and FX rate service (generic capability, no product finance logic) |

## Tech stack

- **Node.js** and **Express 5**, class-based controllers, services and middleware
- **Oracle Database** through `node-oracledb` (thick mode), with the in-house **MongoDB-style query wrapper** (`src/utils/oracle-mongo-wrapper/`)
- Security: JWT auth, double-submit CSRF, Helmet, CORS, rate limiting, IP filter and security filter, argon2 (default) / bcrypt / tripledes / plain password modes
- RFC 5424 logger with daily rotation, request IDs, SSE, scheduler
- ExcelJS for imports and exports, Nodemailer for email
- Vitest and Supertest for tests; `@yao-pkg/pkg` produces a single Windows `.exe`

## Requirements

- Node.js 24 (production builds target `node24-win-x64`)
- Oracle Database, plus Oracle Instant Client for thick mode (`ORACLE_INSTANT_CLIENT`). Not needed with `DEMO_MODE=true`.
- An SMTP server for notifications (optional in development)

## Getting started

```bash
npm install
cp .env.example .env        # then fill in the values (see below)
npm start                   # http://localhost:2106/api/v1/health
```

Every setting is documented in [`.env.example`](.env.example). The main ones:

| Setting | Purpose |
| --- | --- |
| `DEMO_MODE` | `true` runs without Oracle (in-memory demo data) |
| `PORT`, `APP_NAME`, `FRONTEND_BASE_URL` | Listener (default `2106`) and branding |
| `PFX_FILENAME`, `PFX_PASSPHRASE` | Optional HTTPS certificate |
| `DB_HOST`, `DB_PORT`, `DB_APP_SERVICE_NAME` | Oracle connect string (`DB_APP_SERVICE_NAME` is used as the SID) |
| `APP_DB_USERNAME`, `APP_DB_PASSWORD` | Credentials for both pools (`appDb`, `appDbBulk`) |
| `APP_POOL_*`, `APP_BULK_*` | Pool sizing for the two pools |
| `JWT_SECRET`, `CSRF_SECRET`, `COOKIE_SECRET`, `ARGON2_PEPPER`, `DATA_SIGNING_SECRET`, `CHANGELOG_ENCRYPTION_KEY` | Required secrets; short or placeholder values stop a production boot (warning only elsewhere) |
| `CORS_ORIGINS` | Allowed frontend origins |
| `PASSWORD_HASH_MODE` | `argon2` (default), `bcrypt`, `tripledes` or `plain` |
| `SMTP_*`, `ENABLE_SERVER_NOTIFICATIONS` | Email and alert delivery |

### Database

| Situation | Run |
| --- | --- |
| Fresh, empty schema | `sql/01_schema.sql` (drops and recreates the nine `T_*_DEV` tables), optionally `sql/02_seed_demo.sql` |
| Existing schema from an older template | `sql/03_alter_admins_notification_columns.sql`, then `sql/04_platform_tables.sql` (additive) |

See [`sql/README.md`](sql/README.md). Then seed the template accounts:

```bash
npm run db:seed:template
```

## Testing

```bash
npm test                  # everything (vitest run)
npm run test:unit         # also: test:integration, test:security, test:performance,
                          #       test:reliability, test:resilience, test:chaos,
                          #       test:purge, test:metrics, test:money
```

Suites live under `test/server/{unit,integration,security,performance,reliability}`, `test/unit/` and `test/encryption/`. Baseline at the 2026-10-28 re-sync: 77 files / 1254 tests green.

## Scripts

| Command | Does |
| --- | --- |
| `npm start` | Starts `server.js` |
| `npm run lint` | ESLint |
| `npm run db:seed:template` | Seeds the template accounts (`scripts/seed-template.js`) |
| `npm run changelog:dump` / `changelog:seed` | Export / import the encrypted changelog store |
| `npm run build` | Dev-docs freshness index, PKG build, then native-addon copy |

## Build and deploy

```bash
npm run build          # dist/catherine-backend.exe, plus native modules (oracledb, argon2)
```

See [`deploy/`](deploy/):
- [Deployment checklist](deploy/DEPLOYMENT_CHECKLIST.md) and [runbook](deploy/DEPLOYMENT_RUNBOOK.md)
- [`winsw/`](deploy/winsw/): Windows service `catherine-backend` (`stoptimeout` 1860 s)
- [`systemd/`](deploy/systemd/): Linux unit `catherine-backend.service` (`TimeoutStopSec=1860`)

Apply any pending SQL scripts **before** starting a new build.

## Project layout

```
server.js               entry point: HTTP/HTTPS, clustering, scheduler, graceful shutdown
src/
  app.js                Express app and the fixed middleware order
  config/               connection registry (appDb, appDbBulk), Oracle adapter, boot guard, demo mode
  constants/            errors, responses, log message templates, auth tokens
  middleware/           security, auth, cache, traceability, metrics, error handling
  routes/ controllers/ services/ models/
  utils/                logger, oracle-mongo-wrapper, encryption, resilience, money
sql/                    01-04 schema, seed and additive scripts
scripts/                seed, changelog dump/seed, build helpers
test/                   Vitest suites by category
dev-docs/               developer documentation (also served in the app)
deploy/                 WinSW and systemd service files, runbooks
```

## Documentation

- [`CLAUDE.md`](CLAUDE.md): architecture rules, middleware order, env catalogue, auth, routes, SQL
- [`dev-docs/`](dev-docs/): per-feature documents with diagrams and test-backed Q&A, also shown on the in-app **Dev Docs** page
- [`src/utils/oracle-mongo-wrapper/README.md`](src/utils/oracle-mongo-wrapper/README.md): query wrapper API

## License

[Apache-2.0](LICENSE)
