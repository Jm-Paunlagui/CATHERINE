# Getting Started — CATHERINE Template

A production-grade full-stack starter: **React 19 + Vite + Tailwind v4** frontend and
**Node.js + Express 5 + OracleDB** backend, with JWT auth, RBAC, request audit logging,
an observability dashboard, admin management, and a version-history (changelog) feature.

> 📖 **The full interactive Getting Started guide is available in the app itself.**
> Navigate to `/about/getting-started` in the frontend, or visit the page directly
> after starting the dev server: `http://localhost:5173/about/getting-started`

---

## 0. First thing to do

```
1. Install prerequisites (Node 18+, Oracle Instant Client, an Oracle DB)
   — OR just use Demo Mode (DEMO_MODE=true) to skip the database entirely.
2. Backend:  copy .env.example → .env  and generate the secrets
3. Frontend: copy .env.example → .env
4. Create the database (Backend/sql/01_schema.sql) — skip if using Demo Mode
5. npm install  in BOTH Backend/ and Frontend/
6. Start the backend, then the frontend
```

Each step is detailed below. If you only want to look around the UI, set
`DEMO_MODE=true` in `Backend/.env` and skip to [Demo accounts](#7-demo-accounts).

---

## 1. Prerequisites

| Requirement               | Version / Notes                                                                 |
| ------------------------- | ------------------------------------------------------------------------------- |
| **Node.js**               | **18.x** (the backend builds a `node18` pkg target; 18 LTS is the safe choice). |
| **npm**                   | Ships with Node.                                                                |
| **Oracle Database**       | 12c+ for the sample schema. **Oracle XE 21c** is ideal for local dev.           |
| **Oracle Instant Client** | Required — `node-oracledb` runs in **Thick mode**. Set `ORACLE_INSTANT_CLIENT`. |
| **Git**                   | To clone.                                                                       |

Optional but recommended: a SQL client (SQL Developer / SQLcl) to run the schema.

> **Why Oracle Instant Client?** The backend uses the `oracle-mongo-wrapper` library
> over `node-oracledb` in Thick mode. Download Instant Client for your OS and point
> `ORACLE_INSTANT_CLIENT` at the unzipped folder (e.g. `C:\oracle\instantclient_23_8`).

---

## 2. Repository layout

```
CATHERINE/
├── Backend/                  # Express 5 API (OracleDB, JWT, audit, metrics)
│   ├── server.js             # Entry point — `npm start`
│   ├── .env.example          # Documented env vars (copy → .env)
│   ├── sql/                  # ← Sample standalone auth + audit schema (THIS KIT)
│   │   ├── 01_schema.sql
│   │   ├── 02_seed_demo.sql
│   │   └── README.md
│   └── src/                  # app.js, routes, controllers, services, models, …
└── Frontend/                 # React 19 + Vite + Tailwind v4
    ├── .env.example          # Copy → .env
    └── src/
```

---

## 3. Backend setup

### 3.1 Install dependencies

```bash
cd Backend
npm install
```

### 3.2 Create your `.env`

```bash
cp .env.example .env      # Windows PowerShell:  Copy-Item .env.example .env
```

### 3.3 Generate the secrets (required)

Several secrets must be **≥ 32 chars** and unique. Generate each with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set these in `Backend/.env` (each one its own freshly-generated value):

| Variable                   | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `JWT_SECRET`               | Signs/verifies access + refresh JWTs.                          |
| `CSRF_SECRET`              | Double-submit CSRF token secret.                               |
| `COOKIE_SECRET`            | Signs HTTP-only cookies (≥32 chars).                           |
| `ARGON2_PEPPER`            | Server-side pepper mixed into every password hash (≥32 chars). |
| `DATA_SIGNING_SECRET`      | HMAC key for tamper-evident `SYSSIGNATURE` on admin rows.      |
| `CHANGELOG_ENCRYPTION_KEY` | AES-256-GCM key for the encrypted changelog file (64-hex).     |
| `BILLING_HMAC_SECRET`      | Only if you keep the billing/export feature (≥32 chars).       |

> Rotating `ARGON2_PEPPER` invalidates all password hashes; rotating
> `DATA_SIGNING_SECRET` invalidates all admin row signatures. Treat them like keys.

### 3.4 Configure the database connection

In `Backend/.env`:

```ini
DB_TYPE=oracle
DB_HOST=localhost
DB_PORT=1521
ORACLE_INSTANT_CLIENT=C:\oracle\instantclient_23_8

# Password hashing — keep argon2 (OWASP #1)
PASSWORD_HASH_MODE=argon2

# Server
PORT=2108
HOST=0.0.0.0
```

Set the Oracle service name + credentials for your schema. (For the standalone
schema you only need one app connection; the legacy `UA_*` / `MEAL_*` vars are only
used by the legacy auth path.)

### 3.5 Start the backend

```bash
npm start          # node server.js  →  http://localhost:2108
```

Health check: open `http://localhost:2108/api/v1/health` — it should return
`{ "status": "success", ... }`.

---

## 4. Database setup (sample schema)

From a SQL client connected as your app user (see `Backend/sql/README.md` for full
detail):

```bash
# from Backend/sql/
sqlplus APP_USER/APP_PW@//localhost:1521/XEPDB1 @01_schema.sql
sqlplus APP_USER/APP_PW@//localhost:1521/XEPDB1 @02_seed_demo.sql   # optional sample audit rows
```

This creates `T_USERS`, `T_ADMINS`, and `T_AUDIT_LOGS`. The optional second script
fills the audit table with ~200 synthetic rows so the **Logging & Observability**
dashboard renders immediately.

**Seed demo accounts (Argon2id):**

```bash
cd Backend
npm run db:seed:template     # creates admin / user with password Demo@123
```

> The seed must run through the app (not raw SQL) because Argon2id hashes are
> peppered and admin rows are HMAC-signed. This command lands together with the
> standalone-auth wiring noted in the [status box](#0-first-thing-to-do).

---

## 5. Frontend setup

```bash
cd Frontend
npm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
npm run dev                   # Vite dev server (prints the local URL, e.g. http://localhost:5173)
```

Key `Frontend/.env` values:

| Variable                  | Set to                                                                         |
| ------------------------- | ------------------------------------------------------------------------------ |
| `VITE_API_BASE_URL`       | Backend API base **with trailing slash**, e.g. `http://localhost:2108/api/v1/` |
| `VITE_APP_NAME`           | Display name (default `CATHERINE`).                                            |
| `VITE_SESSION_TIMEOUT_MS` | Match the backend `JWT_EXPIRES_IN` (e.g. `1800000` = 30 min).                  |

> Make sure `VITE_API_BASE_URL` points at the **port you set in `Backend/.env`**
> (the example file ships `:3000`; change it to your backend port).

Also add your frontend origin to the backend `CORS_ORIGINS` list (e.g.
`http://localhost:5173`).

---

## 6. Running both together

Open two terminals:

```bash
# Terminal 1 — API
cd Backend && npm start

# Terminal 2 — UI
cd Frontend && npm run dev
```

Then open the Vite URL in your browser and log in.

---

## 7. Demo accounts

After running `npm run db:seed:template` (or in Demo Mode — `DEMO_MODE=true`):

| Username | Password   | Role          | Sees                                              |
| -------- | ---------- | ------------- | ------------------------------------------------- |
| `admin`  | `Demo@123` | `SUPER_ADMIN` | Everything: observability, admin mgmt, changelog. |
| `user`   | `Demo@123` | `USER`        | Standard user views.                              |

Features to explore as `admin`:

- **Logging & Observability** — golden-signal charts powered by `T_AUDIT_LOGS`
  (seed `02_seed_demo.sql` for instant data).
- **Admin Management** — RBAC user/admin CRUD.
- **Version History (Changelog)** — encrypted file store; seed with the changelog
  script (`node scripts/seed-changelog.js`).

---

## 8. Useful commands

### Backend (`Backend/`)

| Command                    | What it does                                  |
| -------------------------- | --------------------------------------------- |
| `npm start`                | Start the API (`node server.js`).             |
| `npm test`                 | Run the Mocha test suite.                     |
| `npm run test:unit`        | Unit tests only.                              |
| `npm run db:seed:template` | Seed demo `admin`/`user` accounts (Argon2id). |
| `npm run build`            | Compile a standalone `.exe` with `pkg`.       |

### Frontend (`Frontend/`)

| Command           | What it does                  |
| ----------------- | ----------------------------- |
| `npm run dev`     | Vite dev server.              |
| `npm run build`   | Production build.             |
| `npm run lint`    | ESLint.                       |
| `npm run preview` | Preview the production build. |

---

## 9. Troubleshooting

| Symptom                                           | Fix                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `DPI-1047` / Oracle Client library not found      | Install Oracle Instant Client and set `ORACLE_INSTANT_CLIENT` to its folder.           |
| `[CryptoVault] ARGON2_PEPPER must be ≥ 32 chars`  | Generate one with the `node -e` command in §3.3 and set it in `Backend/.env`.          |
| `[CryptoVault] DATA_SIGNING_SECRET must be set`   | Same — generate and set a distinct value.                                              |
| Login works but the app can't call the API (CORS) | Add your frontend origin to `CORS_ORIGINS` in `Backend/.env`.                          |
| Frontend hits the wrong port                      | Set `VITE_API_BASE_URL` to your backend port (with trailing slash).                    |
| Health check OK but DB calls fail                 | Check the Oracle service name + credentials; the pool retries lazily on first request. |
| Observability dashboard is empty                  | Run `Backend/sql/02_seed_demo.sql`, or generate traffic by using the app.              |

---

## 10. Where to go next

- `Backend/sql/README.md` — the sample database in detail.
- `Backend/CLAUDE.md` — backend architecture, conventions, and the testing guide.
- `Frontend/CLAUDE.md` — UI component library, design tokens, and feature workflow.
- `Backend/src/utils/oracle-mongo-wrapper/README.md` — the MongoDB-style Oracle API.
