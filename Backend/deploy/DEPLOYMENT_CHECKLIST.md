# CATHERINE Backend — Deployment Checklist

**One page. Run top to bottom. Every line is a thing you can see the answer to.**

Companion to `DEPLOYMENT_RUNBOOK.md` (how to deploy) — this is *did the deploy land correctly*.
Each item exists because it can fail silently. A project built on this template appends its own
schema and functional checks to sections B and D.

---

## A. Before you deploy

- [ ] **A1 — `.env` is present on the host and is the production one.**
      The backend reads `.env` and only `.env`. `server.js` and `src/config/database.js` both
      hardcode that name — nothing loads `.env.production`, which is a *reference copy* you deploy
      **as** `.env`. (Vite auto-loads `.env.production` for the frontend; Node does not. Same
      filename, different rule.)
      For a `pkg` build the file must sit **next to the .exe**, not in the working directory — a
      Windows service can start with cwd anywhere.

- [ ] **A2 — `NODE_ENV=production` in that `.env`.**
      ⚠ This gates more than error formatting. `src/config/bootGuard.js` runs its whole
      fail-closed suite **only** when `NODE_ENV === "production"`; anything else downgrades
      placeholder secrets, `DEMO_MODE=true` and a missing `CORS_ORIGINS` to warnings the process
      starts through. It also switches `ErrorHandlerMiddleware` to generic messages — without it,
      500 responses carry stack traces to the client (CWE-209).
      **The boot guard cannot protect you from the one setting that disables the boot guard.**

- [ ] **A3 — the database connection points at the production schema.**
      `DB_HOST`, `DB_PORT`, `DB_APP_SERVICE_NAME` and `APP_DB_USERNAME` are the production values,
      and `DEMO_MODE=false` (with `DEMO_MODE=true` no Oracle pool is opened at all). Both pools
      (`appDb`, `appDbBulk`) share these credentials, so one wrong value moves all traffic.

- [ ] **A4 — `PASSWORD_HASH_MODE` is the value you intend.**
      Do **not** change it as part of a deploy: it invalidates every stored credential and locks
      out every admin. If it needs to change, that is its own migration.

- [ ] **A5 — `npm audit --omit=dev` is clean**, or every remaining line appears in
      `audit-suppressions.md` with a reachability analysis.

---

## B. Database

- [ ] **B1 — the `sql/` scripts are applied in numeric order** (`01_schema.sql` first), plus any
      project-specific migrations after them. Never apply a script twice.

- [ ] **B2 — every `VARCHAR2` column added since the last release uses character semantics.**

      ```sql
      SELECT TABLE_NAME, COLUMN_NAME, DATA_LENGTH, CHAR_USED
        FROM USER_TAB_COLUMNS
       WHERE DATA_TYPE = 'VARCHAR2' AND CHAR_USED = 'B'
         AND TABLE_NAME IN (/* this release's tables */);
      ```

      Expect no rows.
      ⚠ `CHAR_USED = 'B'` (byte semantics) is the failure to catch here, not a missing column:
      multi-byte text then overflows a column that looks wide enough.

- [ ] **B3 — confirm production's charset matches test.**

      ```sql
      SELECT PARAMETER, VALUE FROM NLS_DATABASE_PARAMETERS
       WHERE PARAMETER = 'NLS_CHARACTERSET';
      ```

      Record the test value and compare. A mismatch (e.g. a single-byte charset such as
      `WE8ISO8859P15` on one side, `AL32UTF8` on the other) invalidates every assumption about
      which characters survive a round-trip — stop and escalate.

- [ ] **B4 — (optional) scan for `¿` replacement characters** in free-text columns. Oracle
      writes `¿` (`CHR(191)`) when a character cannot be represented in the database charset.

      ```sql
      SELECT COUNT(*) FROM <table> WHERE INSTR(<text_column>, CHR(191)) > 0;
      ```

      ⚠ Scope the scan to this application's own tables (`src/constants/purgeTables.js` is the
      authority). A shared Oracle schema may also host other projects' tables; a blind
      `USER_TAB_COLUMNS` sweep will report their data as if it were ours.

---

## C. After the process starts

- [ ] **C1 — the startup log shows both pools opened.** Look for:

      ```
      Pool "appDb" ready (min=…, max=…).
      Pool "appDbBulk" ready (min=…, max=…).
      ```

      ⚠ Then confirm the pools reached the **production** schema, not test: run a read-only query
      that only production can answer (e.g. `SELECT SYS_CONTEXT('USERENV','DB_NAME'),
      SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL` as the app user). An app pointed at the
      test schema looks perfectly healthy while reading and writing the wrong data.

- [ ] **C2 — the boot guard did not exit.** The process is listening, and no
      `process.exit(1)` violation lines appear in the log.

- [ ] **C3 — security headers survive the reverse proxy.**

      ```bash
      curl -sI https://<host>/api/v1/health | grep -iE \
        "x-frame|x-content-type|strict-transport|referrer|permissions|content-security"
      ```

      The test suite asserts these against the Express app directly; only this check sees what a
      proxy in front of Node actually forwards.

- [ ] **C4 — an error response carries no stack trace.** Hit any 404 under `/api/v1/` and confirm
      the body is the generic `{ status, code, message, error }` shape. This is the observable
      proof that A2 took effect.

---

## D. Functional smoke — proves schema, pool and code agree

- [ ] **D1 — log in.** Exercises the `appDb` pool, JWT, and CSRF.
- [ ] **D2 — `GET /api/v1/health/ready` returns 200** with every pool (`appDb`, `appDbBulk`)
      healthy.
- [ ] **D3 — open a screen that reads a column added in this release.** Models use *explicit*
      projections, so a missing column surfaces as `ORA-00904`, not a blank cell.
- [ ] **D4 — run one export.** The workbook opens and money columns carry the expected currency
      format. This exercises the `appDbBulk` pool.
- [ ] **D5 — after any write, allow for the cache TTL** of the store that serves the read before
      concluding the write failed. A cached read lagging a write by up to its TTL is expected
      where the write deliberately does not cross-invalidate that store.

---

## E. Rollback triggers

Stop and roll back if any of these are true:

| Signal | Meaning |
| --- | --- |
| C1 query shows the test database or schema | Writing to the wrong schema |
| `ORA-00904` on a screen | A migration did not land |
| `CHAR_USED = 'B'` on a new `VARCHAR2` column | Needs a `MODIFY` migration first |
| Production `NLS_CHARACTERSET` ≠ test | Charset assumptions invalid — escalate |
| Boot guard exits, or 500s carry stack traces | `NODE_ENV` is not `production` |

---

## Not covered here

CI/CD (not part of the template) and SBOM generation (no pipeline to produce one;
a manually-maintained SBOM that goes stale is worse than none).
