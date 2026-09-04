# Sample Authentication Database (Oracle)

This folder contains the **standalone, project-agnostic** SQL for the template's
authentication, RBAC, and audit-log features. Drop it into any fresh Oracle
schema and the backend has its own users, admins, and audit trail.

| File               | What it does                                                                            |
| ------------------ | --------------------------------------------------------------------------------------- |
| `01_schema.sql`    | Creates `T_USERS_DEV`, `T_ADMINS_DEV` (RBAC + signature), `T_AUDIT_LOGS_DEV` + indexes. |
| `02_seed_demo.sql` | (Optional) Inserts ~200 synthetic audit rows so the dashboard has data.                 |

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
  `TRUNCATE TABLE T_AUDIT_LOGS_DEV;` then re-run it.
- Verify the status-class spread after seeding:
    ```sql
    SELECT STATUS_CATEGORY, COUNT(*) FROM T_AUDIT_LOGS_DEV GROUP BY STATUS_CATEGORY ORDER BY 1;
    ```

## Schema at a glance

```
T_USERS_DEV         ID, USERNAME(unique), PASSWORD(argon2), FIRST_NAME, LAST_NAME,
                EMAIL, IS_ACTIVE, CREATED_AT, UPDATED_AT

T_ADMINS_DEV        ID, USERNAME(unique), PASSWORD(argon2),
                ROLE  CHECK in (SUPER_ADMIN, ADMIN, USER),
                IS_ACTIVE, SYSSIGNATURE(HMAC), CREATED_AT, UPDATED_AT

T_AUDIT_LOGS_DEV    ID, REQUEST_ID, USER_ID, USERNAME, METHOD, ENDPOINT, PARAMS,
                STATUS_CODE, STATUS_CATEGORY, RESPONSE_TIME_MS,
                CLIENT_IP, SERVER_IP, CREATED_AT
                + indexes on CREATED_AT, STATUS_CATEGORY, USER_ID
```

## Money column contract (read before adding any monetary column)

The template ships **no money tables** — money is a capability, not a feature.
But if you add one, these rules are **enforced by backend code** and are
non-negotiable (full rationale in `Backend/CLAUDE.md` → *Money*, and the
`/about/money` reference page). They are booking rules with audit consequences.

| Column class | Oracle type | Rule |
|---|---|---|
| **Posted amount** (balance, credit, debit) | `NUMBER(19,4)` | Input above 4 decimals is **rejected with HTTP 400** by `Money.toStorage()`. Scale 4 covers 3-decimal currencies (KWD/BHD/OMR) with one to spare. |
| **Rate / unit price** | `NUMBER(19,8)` | Higher precision permitted. A rate is **never itself a posting** — do not store it in a `(19,4)` column and do not pass it through `Money.toStorage()`. |

- **Never** use bare `NUMBER`, `FLOAT`, or a raw scaled-integer column for money.
- **No `CURRENCY` column on money tables.** The base currency is a system fact
  (`MONEY_BASE_CURRENCY` in config), not a column on a transaction row. Persist
  only the 3-letter ISO 4217 code where a code is genuinely needed (e.g. a rate
  row's non-base side); symbols are presentation-only.
- Add `CHECK` constraints for non-negative balances and for split invariants
  (a total that decomposes into parts must be constrained to sum back).
- **Bind money as its fixed-scale string** (`Money.toStorage()`, e.g. `"1500.5000"`)
  through `parseUpdate` bind variables — never interpolated, never as a JS number.
  A `fetchTypeHandler` in `src/config/adapters/oracle.js` reads any `NUMBER` with
  **scale > 0 back as a string**, so the value never round-trips through a double.
- **Ledgers and rate rows are append-only.** Never `UPDATE` a posted row or a
  rate: correct with a **reversing entry**, and close/open a new rate window.
- **Base currency is a prospective epoch** (`CURRENCY_CODE` + `EFFECTIVE_FROM`),
  never restated. `bootGuard` refuses an in-place base change once ledger rows
  exist; a change is a new epoch row. No migration script — nothing to migrate.
- **Retention:** money records — BIR RR 17-2013 = 10 years, SOX = 7 years.

Example money column definitions (reference only — the template ships none):

```sql
-- Posted amount: exact, scale 4, non-negative balance guard.
BALANCE      NUMBER(19,4)  DEFAULT 0 NOT NULL  CHECK (BALANCE >= 0),
AMOUNT       NUMBER(19,4)              NOT NULL,
DIRECTION    VARCHAR2(6)               NOT NULL  CHECK (DIRECTION IN ('CREDIT','DEBIT')),

-- Rate / unit price: higher precision, never a posting.
RATE         NUMBER(19,8)              NOT NULL,
CURRENCY_CODE VARCHAR2(3)              NOT NULL,   -- ISO 4217, rate rows only
EFFECTIVE_FROM DATE                    NOT NULL,
EFFECTIVE_TO   DATE,
SOURCE       VARCHAR2(32)              NOT NULL,   -- 'MANUAL' or provider id
```

## Reference money DDL (commented — the template ships none of this)

The template owns **no money tables**. `sql/01_schema.sql` is untouched by the
money capability. The three definitions below are **reference DDL only** — copy
them into your own schema *if and when* you build a money domain, and read the
`/about/money` page and `Backend/CLAUDE.md` → *Money* first. A copier who never
handles money must not inherit empty money tables.

`FxRateService` reads from a table named by `MONEY_FX_TABLE` and is **inert until
you create it**; under `DEMO_MODE=true` it uses an in-memory fixture instead.

```sql
-- ── T_FX_RATE_DEV — exchange rates, append-only, effective-dated (§3.7.9) ──────
-- A rate is NUMBER(19,8) (higher scale than a posting, and never itself a
-- posting). Rows are APPEND-ONLY: a correction closes the current window
-- (EFFECTIVE_TO) and inserts a new row — never UPDATE a rate, or every historical
-- report that used it silently changes. CURRENCY_CODE is the NON-base side; the
-- base currency is a system fact (MONEY_BASE_CURRENCY), never a column.
--
-- CREATE TABLE T_FX_RATE_DEV (
--     ID              NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
--     CURRENCY_CODE   VARCHAR2(3)   NOT NULL,
--     RATE            NUMBER(19,8)  NOT NULL  CHECK (RATE > 0),
--     EFFECTIVE_FROM  DATE          NOT NULL,
--     EFFECTIVE_TO    DATE,                       -- null = still in force
--     SOURCE          VARCHAR2(32)  NOT NULL,     -- 'MANUAL' or a provider id
--     RETRIEVED_AT    DATE          NOT NULL,     -- when obtained (≠ when effective)
--     SET_BY          VARCHAR2(128) NOT NULL,     -- responsible principal
--     CREATED_AT      DATE DEFAULT SYSDATE NOT NULL,
--     CONSTRAINT CK_FX_WINDOW CHECK (EFFECTIVE_TO IS NULL OR EFFECTIVE_TO >= EFFECTIVE_FROM)
-- );
-- CREATE INDEX IX_FX_LOOKUP ON T_FX_RATE_DEV (CURRENCY_CODE, EFFECTIVE_FROM);

-- ── T_MONEY_BASE_EPOCH_DEV — base-currency epochs, prospective (§3.7.10) ───────
-- The base currency is NOT a single value; it is a TIME-KEYED EPOCH. Under IAS 21
-- a change in functional currency is applied PROSPECTIVELY — history is never
-- restated. A money row is interpreted using the base in force at its own
-- CREATED_AT. A change APPENDS a new epoch; it never edits an existing one, and
-- there is NO migration script because under prospective treatment there is
-- nothing to migrate. bootGuard refuses an in-place change to MONEY_BASE_CURRENCY
-- once ledger rows exist (armed by MONEY_LEDGER_TABLES); express a change as a new
-- epoch row instead.
--
-- CREATE TABLE T_MONEY_BASE_EPOCH_DEV (
--     ID              NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
--     CURRENCY_CODE   VARCHAR2(3)   NOT NULL,
--     EFFECTIVE_FROM  DATE          NOT NULL,
--     SET_BY          VARCHAR2(128) NOT NULL,
--     CREATED_AT      DATE DEFAULT SYSDATE NOT NULL
-- );

-- ── T_LEDGER_DEV — single-entry demo ledger (§3.7.5, a documented limitation) ──
-- DIRECTION + AMOUNT is SINGLE-ENTRY: it yields a correct running balance but
-- cannot produce a trial balance or detect a missing counter-posting. That is an
-- acceptable scope for a template AS LONG AS it is stated. Double-entry would add
-- paired postings summing to zero, enforced by a CHECK or a transaction-level
-- assertion. Rows are APPEND-ONLY (§3.7.4): a mistake is corrected with a
-- REVERSING ENTRY (equal-and-opposite, REVERSES_ID set), never an UPDATE.
--
-- CREATE TABLE T_LEDGER_DEV (
--     ID           NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
--     DIRECTION    VARCHAR2(6)   NOT NULL  CHECK (DIRECTION IN ('CREDIT','DEBIT')),
--     AMOUNT       NUMBER(19,4)  NOT NULL  CHECK (AMOUNT >= 0),  -- direction carries the sign
--     MEMO         VARCHAR2(256),
--     REVERSES_ID  NUMBER        REFERENCES T_LEDGER_DEV (ID),   -- set on a reversing entry
--     CREATED_AT   DATE DEFAULT SYSDATE NOT NULL
-- );
-- CREATE INDEX IX_LEDGER_CREATED ON T_LEDGER_DEV (CREATED_AT);
```
