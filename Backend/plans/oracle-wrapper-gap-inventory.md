# oracle-mongo-wrapper — gap inventory from eMeal.API

Source scanned: `eMeal/eMeal.API/src` at `main`. Every string and template literal outside `utils/oracle-mongo-wrapper/` was matched for SQL shapes, with comments stripped. That found 140 literals: 131 statements or SQL fragments, plus 9 documentation strings, which are excluded. Every statement is listed below.

**Purpose:** the backlog for extending CATHERINE's `src/utils/oracle-mongo-wrapper/`. eMeal.API is **not** being changed. It changes only if a critical bug is proven (see "Bugs found in eMeal").

The eMeal wrapper and the CATHERINE wrapper have the same feature set (CATHERINE's is the TypeScript port). So every gap here was checked against the CATHERINE TS source.

## Verdicts

| Verdict | Meaning |
|---|---|
| **NOW** | The CATHERINE wrapper can already express it. |
| **FIX(Gn)** | Possible once wrapper bug Gn is fixed. |
| **FEAT(Gn)** | Needs new wrapper feature Gn. |
| **RAW** | Keep it as raw SQL. If anything, it goes behind a typed `rawQuery<T>()` helper. The DSL would have to grow too much to express it. |

## Gap catalogue

### Wrapper bugs — proven on Oracle 19c, fixed in CATHERINE (2026-11-22)

Each bug was reproduced against eMeal.API's own wrapper on the local Oracle 19c, pool target `test`. Nothing was committed: every statement ran in a transaction that was rolled back. Each fix was then verified the same way through CATHERINE's wrapper and locked in by `test/server/unit/utils/oracleWrapperDefects.test.js`, which fails 13 of 17 tests on the old code.

| ID | Proof (eMeal wrapper) | CATHERINE fix |
|---|---|---|
| G1 | With a row lock held in a session, `find().toArray()` kept the lock, but `find().count()` let a second session take it (`ORA-00054` → `ACQUIRED`). | `count()` and set operations use `autoCommit: !conn` |
| G2 | `limit(1).forUpdate(true)` → `ORA-02014: cannot select FOR UPDATE from view with DISTINCT, GROUP BY, etc.` | Paging moves into a `t0.ROWID IN (…)` subquery and the outer query locks. Adds `{ of, wait, nowait, skipLocked }`; unknown modes throw. |
| G3 | `deleteMany` + correlated `$exists` → `ORA-00904: "T0"."TRANS_ID": invalid identifier` | Every filter-driven statement aliases its table `t0`: find/count/distinct/findOne, update/delete One/Many, replaceOne, findOneAnd*. MERGE's `whenMatchedDelete` correlates to `tgt`. |
| G4 | `$currentDate` → `SET "LAST_HEARTBEAT" = SYSDATE`, stored as `…:58.000000` while SYSTIMESTAMP was `…:58.958934` | `{ $currentDate: { col: { $type: "timestamp" } } }` → `SYSTIMESTAMP` (MongoDB semantics). `true` stays `SYSDATE`; any other value throws. |

**eMeal status:** all four defects are proven in eMeal's copy of the wrapper (`src/utils/oracle-mongo-wrapper`). No eMeal code path triggers them today: eMeal never uses `$currentDate`, `.forUpdate()`, or a correlated `deleteMany`, and its one in-transaction `count()` (`menu.model.js:2220`) runs before any write. Porting is a candidate for 2.1.17.

**G18 (found while fixing G3, existed before): fixed.** `updateOne({})`, `replaceOne({})` and `deleteOne({})` built `… FROM "T" t0  AND ROWNUM = 1`. Proven on Oracle 19c (ORA-00907); they now use `WHERE ROWNUM = 1`.

#### Original defect notes

| ID | Defect | Location |
|---|---|---|
| G1 | `QueryBuilder.count()` executes with `autoCommit: true` even when bound to a session. Inside a transaction that already wrote, this commits the transaction and drops its row locks. `toArray()` and `countDocuments()` correctly use `autoCommit: !this._conn`. | `core/QueryBuilder.ts:563` |
| G2 | `limit()` / `findOne()` plus `forUpdate()` emits `FETCH FIRST n ROWS ONLY FOR UPDATE`, which Oracle rejects (ORA-02014). `forUpdate()` also has no `OF col` and no `WAIT n` mode. | `core/QueryBuilder.ts:329-337` |
| G3 | `deleteMany` gives the target no `t0` alias, but a correlated `$exists` / `$notExists` emits `t0.col`, so the SQL compiles and then fails with ORA-00904. | `core/OracleCollection.ts:1452`, `parsers/filterParser.ts` |
| G4 | `$currentDate` writes `SYSDATE`, a DATE, so TIMESTAMP columns lose fractional seconds. A `{ $type: "timestamp" }` form that emits `SYSTIMESTAMP` is needed. | `parsers/updateParser.ts` |

### Missing features

**Built in CATHERINE (2026-11-22)** — the four that CATHERINE's own statements need; unit-tested
(`test/server/unit/utils/oracleWrapperFeatures.test.js`) and verified on Oracle 19c in rolled-back transactions:

| ID | API | CATHERINE statement migrated |
|---|---|---|
| G6 | `{ col: { $lt: { $now: { minus: { days: n } } } } }` (`plus`, days / hours / minutes / seconds; amounts bound via `NUMTODSINTERVAL`) | `serverAlertLog.purgeOlderThan` |
| G10 | `new Transaction(db).withReadOnlyTransaction(fn)` (`SET TRANSACTION READ ONLY` first, always rolled back) | `DataPurgeModel.streamAllTables` |
| G11 | `deleteMany(filter, { limit })` (`AND ROWNUM <= :del_limit`) | `AuthRefreshTokenModel.purgeExpired` |
| G17 | `updateMany` / `deleteMany` `{ returning: [cols] }` → `result.returning`, one object per row (values as strings) | `AuthRefreshTokenModel.revokeUser` |

**Deferred (YAGNI)** — G5, G7, G8, G9, G12, G13, G14, G15, G16 serve only eMeal statements, and eMeal is not
adopting the wrapper yet. Build each when a caller needs it.


| ID | Feature | Shape suggestion |
|---|---|---|
| G5 | Column-to-column comparison in a filter, and a column expression in `$set` | filter `{ DOWNLOAD_COUNT: { $lt: { $col: "MAX_DOWNLOADS" } } }`; update `{ $set: { A: { $expr: … } } }` covering `GREATEST(col - 1, 0)`, `NVL(a, b)`, `CASE` |
| G6 | Server-time arithmetic in a filter | `{ CREATED_AT: { $lt: { $now: { minus: { days: n } } } } }` → `SYSTIMESTAMP - NUMTODSINTERVAL(:n,'DAY')` |
| G7 | Table lock | `db.lockTable(name, "EXCLUSIVE", { nowait: true }, conn)` |
| G8 | Sequence values | `db.nextVal(seq, n = 1, conn)` → one value, or a `CONNECT BY LEVEL` batch |
| G9 | Stored procedure / PL/SQL block call | `db.callProcedure(name, binds, { many: rows, conn })`; names checked as identifiers, values bound |
| G10 | Read-only snapshot transaction | `new Transaction(db).withReadOnlyTransaction(fn)` (issues `SET TRANSACTION READ ONLY` first) |
| G11 | Bounded and keyed deletes | `deleteMany(filter, { limit })` (`ROWNUM <= :lim`); `bulkDeleteByKeys(keys, rows)` through `executeMany` (the delete counterpart of `bulkUpdateByKeys`) |
| G12 | `insertFromQuery` completeness | return `rowsAffected`; target→source column mapping; bound constant columns (`$literal`); `CASE` columns; a JOINed source |
| G13 | Expression columns in projection, filter and RETURNING | `$toString` (`TO_CHAR` of a NUMBER, lossless past 2^53), `TO_CHAR(ts, fmt)`, `NVL2`, a filter on an expression (`TO_CHAR(STARTED_DATE,…) = :epoch`), RETURNING an expression |
| G14 | Analytic reporting SQL | conditional accumulators (`SUM(CASE…)`, `COUNT(CASE…)`), computed or variable-length `$switch` group keys, filtering on a window-function result, CTE + UNION, null-safe join (`DECODE(a,b,1,0)=1`) |
| G15 | Case-insensitive substring search over text + `TO_CHAR`'d numbers | `$contains: { value, caseInsensitive, castToString }` → `INSTR(UPPER(TO_CHAR(col)), UPPER(:v)) > 0`; literal, **not** a regex |
| G16 | Registry-driven generic access | table and column names from an allow-list plus `USER_TAB_COLUMNS`; a `db.describeTable(name)` helper |
| G17 | Multi-row RETURNING | `updateMany` / `deleteMany` with `returning` into array out-binds |

## Inventory

### models/rfid.management.model.js (23)

| Line | Statement | Verdict |
|---|---|---|
| 66 | `BEGIN SP_ARCHIVE_EMP_MASTER(...)` via `executeMany` (bulk archive) | FEAT(G9) |
| 166 | Fragment: QR beyond-30 flag `CASE WHEN SYSTIMESTAMP >= TRUNC(EXPIRATION_DATE)+1` | FEAT(G13, G6) |
| 177 | Lifecycle CTE: per-cutoff consumption + `UNION` of three tables + CASE flags | RAW (G14) |
| 216 | Fragment: `ADD_MONTHS(GREATEST(ARCHIVED_DATE, NVL((scalar MAX subquery), …)), 1)` | RAW (G13) |
| 293 | Employee by GID + card, NUMBER columns `TO_CHAR`'d | FEAT(G13) |
| 387 | Employees by chunked `OR` of (GID, card) pairs, `TO_CHAR`'d | FEAT(G13) |
| 487 | Active employee page, `REGEXP_LIKE` search, `TO_CHAR`'d | FEAT(G13, G15). See BUG-1 |
| 512 | Count for 487 | FEAT(G15) |
| 519 | Entity summary `GROUP BY ENTITY` with the same search | FEAT(G15) |
| 659 | `SP_ARCHIVE_EMP_MASTER` single call | FEAT(G9) |
| 1026 | `SP_ARCHIVE_EMP_MASTER` single call (archive path) | FEAT(G9) |
| 1036 | `UPDATE … ARCHIVED_DATE = SYSDATE WHERE … ARCHIVED_DATE IS NULL` | NOW (`updateOne` + `$currentDate`) |
| 1093 | Archived page, `REGEXP_LIKE` search | FEAT(G13, G15). See BUG-1 |
| 1112 | Count for 1093 | FEAT(G15) |
| 1210 | Archive history by `REF_GID`, `TO_CHAR`'d | FEAT(G13) |
| 1846 | Export, `LIKE` on `TO_CHAR` | FEAT(G13, G15) |
| 1959 | Employee by GID, `TO_CHAR`'d | FEAT(G13) |
| 2032 | Employees `GID IN (chunked)`, `TO_CHAR`'d (the wrapper `$in` already chunks at 1000) | FEAT(G13) |
| 2149 | Employees `CARD_NUMBER IN (chunked)`, `TO_CHAR`'d | FEAT(G13) |
| 2234 | Lifecycle row: eligibility expression + CASE + `SYSDATE`, `FOR UPDATE OF t.GID WAIT 5` | RAW (G2, G13) |
| 2317 | Download-after-period-end CTE, CASE inside the join predicate | RAW (G14) |
| 2408 | QR distribution CTE, `DECODE` null-safe join, `MIN(flag)` per group | RAW (G14) |
| 2480 | `COUNT(*)` pending reset requests on an optional caller connection | FIX(G1) |

### models/admin.takeover.model.js (19), all inside one `withTransaction`

Table names come from a two-entry constant map. `session.collection(f.request)` covers them.

| Line | Statement | Verdict |
|---|---|---|
| 179 | Target admin row `FOR UPDATE` | NOW (`find().forUpdate(true).toArray()`, no limit) |
| 200 | Pending requests by requester `FOR UPDATE` | NOW |
| 208 | Cancel pending: `RESOLVED_AT = SYSTIMESTAMP` | FIX(G4) |
| 221 | All pending `FOR UPDATE` | NOW |
| 239 | Rewrite recipient columns by `REQUEST_ID` | NOW |
| 261 | Tracker self-join x↔y on null-safe `DECODE` keys, `FOR UPDATE` | RAW (G14, G2) |
| 274 | `SELECT *` tracker by id | NOW |
| 276 | Tracker counts by id | NOW |
| 281 | Requests by tracker | NOW |
| 285 | Repoint requests to the surviving tracker | NOW (`updateMany`) |
| 292 | Set merged counts by id | NOW |
| 295 | Delete merged tracker | NOW |
| 310 | Trackers by owner `FOR UPDATE` | NOW |
| 314 | Reassign tracker owner | NOW (`updateMany`) |
| 319 | Requests by column `FOR UPDATE` (column from a constant list) | NOW |
| 326 | Reassign + `ORIGINAL_REQUESTED_BY = NVL(ORIGINAL_REQUESTED_BY, REQUESTED_BY)` | FEAT(G5) |
| 343 | Insert takeover record `RETURNING TAKEOVER_ID` | NOW (`insertOne` + `returning`) |
| 383 | Set `ROW_HASH` | NOW |
| 405 | List takeovers ordered | NOW |

### models/subsidy.correction.job.model.js (17)

`EPOCH_EXPR = TO_CHAR(STARTED_DATE,'YYYYMMDDHH24MISSFF6')` is a fencing token compared and returned in SQL.

| Line | Statement | Verdict |
|---|---|---|
| 197 | PL/SQL: item `PENDING→OK/FAILED` + job counter `+1`, each guarded by `SQL%ROWCOUNT` | FEAT(G9). Two `updateOne` calls in a Transaction would also work, but need G13 for the epoch predicate. |
| 242 | Create job `RETURNING JOB_ID, EPOCH_EXPR` | FEAT(G13) |
| 279 | Insert items via `executeMany` | NOW (`insertMany`) |
| 298 | Delete job (rollback of a half-created job) | NOW |
| 330 | Mark running: `CASE` on STATUS for `STARTED_DATE`, `SYSTIMESTAMP`, `RETURNING EPOCH_EXPR` | FEAT(G5, G13) + FIX(G4) |
| 362 | Heartbeat `WHERE EPOCH_EXPR = :epoch` | FEAT(G13) + FIX(G4) |
| 442 | Mark cascading, epoch-fenced | FEAT(G13) + FIX(G4) |
| 465 | Mark completed, epoch-fenced | FEAT(G13) + FIX(G4) |
| 490 | Mark interrupted, epoch-fenced | FEAT(G13) + FIX(G4) |
| 511 | Stale sweep `LAST_HEARTBEAT < SYSTIMESTAMP - NUMTODSINTERVAL(:s,'SECOND')` | FEAT(G6) + FIX(G4) |
| 535 | Resume interrupted `RETURNING EPOCH_EXPR` | FEAT(G13) + FIX(G4) |
| 561 | Job by id | NOW |
| 573 | Active jobs | NOW |
| 607 | Job page `OFFSET/FETCH` | NOW |
| 628 | Job count | NOW |
| 656 | Item keyset page `SEQ > :after … FETCH NEXT` | NOW |
| 689 | OK item GIDs ordered | NOW |

### models/consumption.model.js (13 literals, 12 statements)

| Line | Statement | Verdict |
|---|---|---|
| 655 | `SET TRANSACTION READ ONLY` | FEAT(G10) |
| 706 | `SET TRANSACTION READ ONLY` | FEAT(G10) |
| 775 | `SET TRANSACTION READ ONLY` | FEAT(G10) |
| 1161–1253 | Connection-signature query: per-GID conditional counts over `TAP_RESET_REQUEST` (fragment at 1250) | FEAT(G14) |
| 3035 | Delete settlements `RETURNING GID, NVL2(SECONDARY_SETTLED_DATE,0,1)` (multi-row) | FEAT(G17, G13) |
| 3070 | Insert settlements via `executeMany` (money as strings with `bindDefs` NUMBER) | NOW (`insertMany`). Verify money strings get NUMBER `bindDefs`. |
| 3081 | Delete excess-fund rows by (GID, cutoff) via `executeMany` | FEAT(G11) |
| 3087 | Insert excess-fund rows via `executeMany` | NOW (`insertMany`), same money note |
| 3703 | Wallet balance `FOR UPDATE` | NOW (`find().forUpdate(true).toArray()`) |
| 3823 | Two scalar `NVL(SUM())` subqueries `FROM DUAL` | NOW as two aggregates in the session; FEAT(G14) for one round trip |
| 5001–5002 | Wallet ids by (GID, cutoff) `FOR UPDATE` (one statement, two literals) | NOW |
| 5020 | `COUNT(*)` re-check inside the locked transaction | FIX(G1). The code comment documents G1 exactly. |

### models/sales.model.js (9), all RAW (G14)

They project into a CTE, compute a window-function flag (`MIN(CASE…) OVER (PARTITION BY E_SIGN_NO, PO_REF)`), shift the time zone with `NUMTODSINTERVAL`, group by the CASE tree from `SalesPeriodService.buildBandSql`, and use conditional counts.

| Line | Statement |
|---|---|
| 488 | QR projection grouped by (E_SIGN_NO, PO_REF, band) |
| 606 | Issued total over distributions filtered on the window flag |
| 698 | Day × band buckets |
| 764 | Live-row signature (max id, sums) where flag = 0 |
| 854 | Per-station × band rollup |
| 941 | Shared CTE for the station ledger (used by 956, 973) |
| 956 | Station ledger page, filtered on the window flag in the outer query |
| 973 | Count for 956 |
| 1042 | Per-distribution ledger |

`services/SalesPeriodService.js:723` `buildBandSql` builds a variable-length `CASE WHEN … THEN :code` tree (binds only) used as the GROUP BY key above. It belongs to G14 (a `$switch` group key).

### models/auth.refresh.token.model.js (7)

| Line | Statement | Verdict |
|---|---|---|
| 28 | Insert token row | NOW |
| 32 | Rotate `WHERE USED_AT IS NULL AND REVOKED_AT IS NULL` | NOW (`updateOne`, null filters) |
| 36 | Token state by hash | NOW |
| 38 | Revoke family | NOW (`updateMany`) |
| 45 | Revoke user `RETURNING FAMILY_ID INTO :fids` (multi-row) | FEAT(G17) |
| 54 | Recently revoked: `GROUP BY FAMILY_ID MAX(REVOKED_AT) FETCH FIRST :lim` | NOW (`aggregate` `$match/$group/$limit`) |
| 60 | Purge `WHERE EXPIRES_AT < :cutoff AND ROWNUM <= :lim` | FEAT(G11) |

### models/billing.integrity.model.js (6)

Lines 264, 501, 676, 810, 911 and 1259 are all `SET TRANSACTION READ ONLY`, opening a consistent snapshot for multi-table integrity reads. All FEAT(G10).

### models/emp.delete.snapshot.model.js (5)

| Line | Statement | Verdict |
|---|---|---|
| 193 | Per-source snapshot SELECT from the constant `SNAPSHOT_SOURCES` (column lists may `TO_CHAR`) | FEAT(G13) |
| 198 | Insert snapshot `RETURNING SNAPSHOT_ID, TO_CHAR(SNAPSHOT_AT, fmt)` | FEAT(G13) |
| 207 | Set `ROW_HASH` | NOW |
| 218 | Snapshots `GID IN (…)` with `TO_CHAR(SNAPSHOT_AT)` | FEAT(G13) |
| 399 | Snapshots by GID with `TO_CHAR(CARD_NUMBER)` | FEAT(G13) |

### models/transaction.archive.model.js (5)

| Line | Statement | Verdict |
|---|---|---|
| 243 | `INSERT … SELECT` live→archive, named 11-column list, bound constants `:archivedAt, :half`, `NOT EXISTS` | FEAT(G12) |
| 262 | `DELETE` live rows with correlated `EXISTS` in archive | FIX(G3) |
| 342 | `INSERT … SELECT` with a `JOIN T_CUTOFF_DATE` and a `CASE` half column | FEAT(G12) |
| 364 | `DELETE` with correlated `EXISTS` | FIX(G3) |
| 678 | `SET TRANSACTION READ ONLY` | FEAT(G10) |

### models/data-purge.model.js (4)

| Line | Statement | Verdict |
|---|---|---|
| 354 | `SET TRANSACTION READ ONLY` | FEAT(G10) |
| 447 | `USER_TAB_COLUMNS` for a registry table | FEAT(G16) |
| 503 | Generic paged stream of a registry table, `TO_CHAR` timestamp/identifier columns | RAW (G16, G13) |
| 678 | `USER_TAB_COLUMNS` | FEAT(G16) |

### models/payperiod.model.js (4)

| Line | Statement | Verdict |
|---|---|---|
| 157 | `LOCK TABLE T_CUTOFF_DATE IN EXCLUSIVE MODE NOWAIT` | FEAT(G7) |
| 160 | `T_CUTOFF_DATE_SEQ.NEXTVAL` | FEAT(G8) |
| 170 | n × `NEXTVAL` via `CONNECT BY LEVEL` | FEAT(G8) |
| 277 | `NEXTVAL` | FEAT(G8) |

### models/serverAlertLog.model.js (4)

| Line | Statement | Verdict |
|---|---|---|
| 63 | Insert alert (CLOB details) | NOW |
| 200 | Count with optional filters | NOW |
| 207 | Page `ORDER BY CREATED_AT DESC, ID DESC` | NOW |
| 267 | Purge `CREATED_AT < SYSTIMESTAMP - :days` | FEAT(G6) |

### models/meal.adm.model.js (3), inside `withLastSuperAdminGuard`

| Line | Statement | Verdict |
|---|---|---|
| 828 | Active SUPER_ADMIN set `FOR UPDATE` | NOW |
| 837 | Target role and active flag | NOW |
| 850 | Count other active SUPER_ADMINs | FIX(G1) |

### Download-slot quota: billing.model.js (2), sales.download.model.js (2)

| Line | Statement | Verdict |
|---|---|---|
| billing 212, sales.download 300 | `SET DOWNLOAD_COUNT = DOWNLOAD_COUNT + 1 WHERE … AND DOWNLOAD_COUNT < MAX_DOWNLOADS` | FEAT(G5) (`$inc` exists; the column compare is missing) |
| billing 253, sales.download 324 | `SET DOWNLOAD_COUNT = GREATEST(DOWNLOAD_COUNT - 1, 0)` | FEAT(G5) |

### Single statements

| File:line | Statement | Verdict |
|---|---|---|
| models/billing.report.model.js:339 | GID search: `INSTR(UPPER(TO_CHAR(col)), UPPER(:search))` × 4 | FEAT(G15) |
| models/resign-vote.model.js:63 | Stale-lock delete: `VOTED_AT < SYSTIMESTAMP - NUMTODSINTERVAL`, correlated `NOT EXISTS` with `REGEXP_LIKE` | FEAT(G6) + FIX(G3) |
| models/subsidy.correction.model.js:375 | Keyed `UPDATE` via `executeMany` | NOW (`bulkUpdateByKeys`) |
| services/SalesPeriodService.js:115 | `LOCK TABLE T_SALES_PERIOD IN EXCLUSIVE MODE NOWAIT` | FEAT(G7) |
| services/DataRestoreService.js:596 | Registry table `pk IN (:p0…)` with `TO_CHAR` timestamp columns | RAW (G16, G13) |
| routes/health.route.js:160 | `SELECT 1 FROM DUAL` probe | RAW (fine; optionally `db.ping()`) |
| services/ReadinessService.js:71 | `SELECT 1 FROM DUAL` probe | RAW |
| utils/dbTimezone.js:56 | DB session time-zone offset from `SYSTIMESTAMP` | RAW |

### Excluded (documentation text, not SQL)

`constants/runtimeModel.js` (87 ×2, 207, 541), `constants/architectureModel.js` (99, 804, 813), `constants/messages/database.messages.js:24`, `services/email/ServerNotificationService.js:446`.

## Totals

| Verdict | Statements |
|---|---|
| NOW (wrapper already can) | 43 |
| FIX only (G1–G4) | 6 |
| FEAT (G5–G17), may also need a fix | 62 |
| RAW (keep raw / `rawQuery<T>`) | 20 |
| **Total** | **131** |

Statements removed per gap, in suggested order (a statement can count under more than one):

| Order | Gap | Statements it unblocks |
|---|---|---|
| 1 | G1 count autoCommit | 3 |
| 2 | G3 deleteMany alias | 3 |
| 3 | G4 timestamp `$currentDate` | 8 (with G13 for 6 of them) |
| 4 | G2 forUpdate limit / OF / WAIT | enables 2234-style locks; correctness for any `findOne().forUpdate()` |
| 5 | G10 read-only transaction | 11 |
| 6 | G13 expression columns | 22 |
| 7 | G7 / G8 / G9 db primitives | 2 / 3 / 4 |
| 8 | G5 column compare + `$set` expressions | 6 |
| 9 | G6 `$now` arithmetic | 4 |
| 10 | G15 literal substring search | 7 |
| 11 | G11 / G17 bounded, keyed and multi-row RETURNING deletes | 2 / 2 |
| 12 | G12 insertFromQuery | 2 |
| 13 | G14 analytic SQL | decide: DSL growth vs `rawQuery<T>` |

## Bugs found in eMeal

No **critical** bug was proven.

- **No SQL injection.** Every `${…}` spliced into SQL text was traced: constants, allow-listed identifiers (purge registry, takeover table map, `USER_TAB_COLUMNS`), or generated `:pN` bind lists. All values are bound.
- **G1 is not triggered harmfully in eMeal.** `menu.model.js:2220` calls `.count()` inside a transaction, but it is the first statement, so the stray commit has nothing pending. Every other in-transaction count is raw SQL, written that way to avoid G1.
- **G2 and G3 are not hit.** eMeal never calls `.forUpdate()` on a builder, and it writes the correlated deletes as raw SQL.

**BUG-1 (medium, not critical): the employee search is treated as a regex.**
- `rfid.management.model.js:487/512/519` and `:1093/1112` bind the raw `req.query.search` as the pattern of `REGEXP_LIKE`.
- A search such as `(` or `[` makes Oracle raise ORA-12725 / ORA-12726, and the RFID list returns 500.
- `.` matches every row.
- A nested quantifier can force heavy backtracking over the whole table.
- A repeated `?search=a&search=b` arrives as an array, and `.trim()` throws a TypeError.
- No injection, and the route is admin-only.
- The fix belongs in eMeal only if the owner decides it is worth it: switch to the literal `INSTR` search `billing.report.model.js:339` already uses (G15).
- Proving it needs an Oracle connection. That was not done here.
