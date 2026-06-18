# Sample Authentication Database (Oracle)

This folder contains the **standalone, project-agnostic** SQL for the template's
authentication, RBAC, and audit-log features. It is **not** tied to the HRIS
(`U_USERS`) or Meal (`T_EMP_MGMT_ADMIN`) databases — drop it into any fresh Oracle
schema and the backend has its own users, admins, and audit trail.

| File              | What it does                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `01_schema.sql`   | Creates `T_USERS`, `T_ADMINS` (RBAC + signature), `T_AUDIT_LOGS` + indexes. |
| `02_seed_demo.sql`| (Optional) Inserts ~200 synthetic audit rows so the dashboard has data.     |

> **Accounts are seeded by a Node script, not SQL.** Argon2id hashes are peppered
> with `ARGON2_PEPPER` and each admin row is HMAC-signed with `DATA_SIGNING_SECRET`,
> so valid rows can only be produced by the app. See the project root
> `GETTING_STARTED.md` for the seed command.

## Prerequisites

- **Oracle Database 12c or newer** (XE 18c / 21c is perfect for local dev).
  IDENTITY columns and inline CHECK constraints require 12c+.
- A schema/user you can connect to (e.g. `APP_USER`) with `CREATE TABLE` privilege.
- A SQL client: **SQL\*Plus**, **SQLcl**, **SQL Developer**, or **VS Code + Oracle Dev Tools**.

## How to run

### Option A — SQL\*Plus / SQLcl (command line)

```bash
# from Backend/sql/
sqlplus APP_USER/APP_PASSWORD@//localhost:1521/XEPDB1 @01_schema.sql
sqlplus APP_USER/APP_PASSWORD@//localhost:1521/XEPDB1 @02_seed_demo.sql   # optional
```

### Option B — SQL Developer / any GUI

1. Open a worksheet connected as your app user.
2. Open `01_schema.sql`, run the whole script (F5 / "Run Script").
3. (Optional) Open `02_seed_demo.sql`, run it for sample dashboard data.

## Notes

- `01_schema.sql` is **idempotent**: it drops the three template tables first
  (ignoring "table does not exist"), so you can re-run it safely. Comment out the
  `RESET` block at the top if you want `CREATE` to fail on an existing table.
- `02_seed_demo.sql` only `INSERT`s. To reset the sample data:
  `TRUNCATE TABLE T_AUDIT_LOGS;` then re-run it.
- Verify the status-class spread after seeding:
  ```sql
  SELECT STATUS_CATEGORY, COUNT(*) FROM T_AUDIT_LOGS GROUP BY STATUS_CATEGORY ORDER BY 1;
  ```

## Schema at a glance

```
T_USERS         ID, USERNAME(unique), PASSWORD(argon2), FIRST_NAME, LAST_NAME,
                EMAIL, IS_ACTIVE, CREATED_AT, UPDATED_AT

T_ADMINS        ID, USERNAME(unique), PASSWORD(argon2),
                ROLE  CHECK in (SUPER_ADMIN, ADMIN, USER),
                IS_ACTIVE, SYSSIGNATURE(HMAC), CREATED_AT, UPDATED_AT

T_AUDIT_LOGS    ID, REQUEST_ID, USER_ID, USERNAME, METHOD, ENDPOINT, PARAMS,
                STATUS_CODE, STATUS_CATEGORY, RESPONSE_TIME_MS,
                CLIENT_IP, SERVER_IP, CREATED_AT
                + indexes on CREATED_AT, STATUS_CATEGORY, USER_ID
```
