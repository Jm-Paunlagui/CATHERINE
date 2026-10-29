"use strict";

/**
 * @fileoverview Data Purge & Restore — backup archive builder.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Builds the downloadable `.zip` a SUPER_ADMIN must obtain before a purge
 * is allowed to run, and issues the backup token (`BackupTokenService`)
 * that `DataPurgeService.executePurge` later verifies — this is the
 * server-side enforcement of "backup before delete" (CWE-602; an FE
 * stepper gate alone is client-side-only enforcement).
 *
 * HOW IT WORKS
 * ------------
 * `manifest.json` + `signature.json` + `data/<TABLE>.jsonl` (one per
 * table, streamed via `DataPurgeModel.streamTable` so no table is ever
 * fully materialised in memory) + `readable/backup-summary.xlsx` (a
 * human-eyeball copy only, capped at `BACKUP_XLSX_ROW_CAP` rows/sheet).
 *
 * `readable/backup-summary.xlsx` is NEVER the restore source — Excel
 * silently mangles numeric values beyond 15 significant digits, so a long
 * numeric identifier would not survive the round trip. JSONL, with every identifier column
 * pre-serialised as an exact digit STRING at the SQL level (see
 * `DataPurgeModel.streamTable`), is the only safe restore source — the
 * restore phase (out of scope here) will read `data/*.jsonl`, never the
 * `.xlsx`.
 *
 * `signature.json.digest` is an HMAC-SHA256 (`CryptoVault.signRecord`,
 * `DATA_SIGNING_SECRET`) over the SORTED file→SHA-256 map — a future
 * restore verifies this before touching the DB and refuses a tampered or
 * foreign archive. Only the SIGNING side is implemented in this phase;
 * verification belongs to the restore phase.
 *
 * The backup token is issued by `BackupTokenService` (a separate class —
 * see that file's header for why this isn't inlined here) bound to
 * `(adminId, scopeHash, rowCounts)`; `rowCounts`' key set is what makes
 * the token un-replayable against a wider scope than this exact backup
 * covered.
 *
 * EXAMPLE
 * -------
 *   const { zipBuffer, filename, token, expiresAt, confirmPhrase } =
 *       await BackupArchiveService.buildBackup({
 *           selection: { groups: ["T_"] },
 *           adminId: 10234,
 *           requestId: req.id,
 *       });
 *   res.set({
 *       "Content-Type": "application/zip",
 *       "Content-Disposition": `attachment; filename="${filename}"`,
 *       "X-Backup-Token": token,
 *   }).send(zipBuffer);
 *
 * SCHEDULED DB BACKUP EXTENSIONS
 * -----------------------------------------------------------------------
 * `buildBackup` (this is ALWAYS the purge-gating backup — its only caller
 * today is `DataPurgeController.backup`) and the new `buildScheduledBackup`
 * (for the SCHEDULED/MANUAL whole-DB backup feature, orchestrated by
 * `BackupStoreService` — not built in this phase) now share one read path,
 * `_streamAndHashTables`: every table is read through
 * `DataPurgeModel.streamAllTables` — ONE connection, ONE
 * `SET TRANSACTION READ ONLY` transaction spanning every table —
 * with a per-table SHA-256 computed as a RUNNING hash while each batch
 * streams past (never a `crypto.createHash().update(wholeBuffer)` call after
 * the fact — see that method's doc comment). On `err.isSnapshotTooOld`
 * (never message-text sniffing — the model's own documented contract) it
 * falls back to the pre-existing per-table `DataPurgeModel.streamTable` path
 * and the manifest is stamped `readConsistent: false`.
 *
 * `buildBackup` NEVER dedups against a previous archive and NEVER joins the
 * scheduled-backup chain (the purge-gating backup must be
 * self-contained and outlive any other file on disk) — every table it reads
 * is unconditionally `state: "INCLUDED"`, `manifest.chain` is `null`, and
 * `manifest.mode` is always `"FULL"`. `buildScheduledBackup` is the one that
 * accepts a `previousTableState` map and can mark a table `"UNCHANGED"`.
 *
 * ── ORA-01555 critical-log decision ("not fixed in step 3") ──
 * `db.withConnection` (`src/config/adapters/oracle.js#withConnection`, a
 * shared path this feature does NOT own or edit) unconditionally
 * `logger.critical`s any callback error — including a handled ORA-01555 —
 * BEFORE `DataPurgeModel.streamAllTables` gets a chance to convert it into
 * its documented `isSnapshotTooOld` signal. That `critical` line feeds
 * `AlertNotifierService`'s `server-critical-notification` digest channel, so
 * a backup that gracefully degraded to a torn-snapshot fallback (and still
 * SUCCEEDED, just with `readConsistent:false`) can still page an operator
 * who opted into critical alerts.
 *
 * DECISION: **accept**, do not suppress or re-label. Reasoning:
 *   1. By the time `_streamAndHashTables` observes `err.isSnapshotTooOld`,
 *      `oracle.js` has ALREADY written the critical line and (in a running
 *      server) already handed it to whatever critical-log tap is
 *      subscribed — there is nothing left to "un-log" from this file.
 *   2. The only way to prevent the line from being emitted at all is to
 *      narrow `oracle.js#withConnection`'s unconditional
 *      `logger.critical(oracleMessages.OP_FAILED(...))` call — a SHARED
 *      path every other feature in this codebase also depends on for its
 *      own critical-failure visibility. Narrowing it for this one caller's
 *      benefit is a change with its own blast radius and its own review,
 *      explicitly out of scope for this step (and explicitly not to be
 *      done here per the step's own instructions).
 *   3. A "suppress after the fact" approach (e.g. telling
 *      `AlertNotifierService` to retroactively drop a specific critical
 *      event) would require this file to reach into the alerting
 *      subsystem's internals with a message-content match — a fragile,
 *      easily-desynced coupling for a once-in-a-while, already-survivable
 *      condition, and a bigger surface change than this step's stated
 *      remit (`BackupArchiveService` + `BackupStoreService` only).
 *   4. ORA-01555 on a long read-only transaction is rare in practice, and
 *      an operator who opted into the critical channel seeing "a backup hit
 *      a busy-database condition and safely degraded" once in a while is an
 *      acceptable false-positive rate for a channel whose entire purpose is
 *      "look at this, it might matter" — it is not a wrong alert, just an
 *      imprecise one. `_streamAndHashTables` still separately logs its own
 *      `notice` (`dataBackupMessages.ARCHIVE_READ_FALLBACK`) tying the event
 *      to the SPECIFIC archive build, so an operator who does receive the
 *      critical page can immediately correlate it with "backup X fell back,
 *      here is why" instead of a bare Oracle stack trace.
 *   A future step MAY revisit this by narrowing `oracle.js`'s critical log to
 *   exclude errors the callback itself already reclassified (e.g. an
 *   `err.expectedBusinessError` convention) — tracked as a follow-up, not
 *   done here.
 */

const crypto = require("crypto");
const { PassThrough } = require("stream");
const archiver = require("archiver");
const ExcelJS = require("exceljs");

const { logger } = require("../utils/logger");
const { touch } = require("../utils/progress/progress");
const { dataPurgeMessages, dataBackupMessages } = require("../constants/messages");
const { getEntry } = require("../constants/purgeTables");
const DataPurgeModel = require("../models/data-purge.model");
const DataPurgeService = require("./DataPurgeService");
const BackupTokenService = require("./BackupTokenService");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const { addNormalizedRow } = require("../utils/excelFormat");
// Resolved at runtime relative to this file.
const { version: APP_VERSION } = require("../../package.json");

/** Schema baseline this feature was built against — plan header, and echoed into every manifest for restore-time compatibility checks (a later phase). */
const SCHEMA_VERSION = "v6";

/** Default rows/sheet cap for the readable xlsx when BACKUP_XLSX_ROW_CAP is unset. */
const DEFAULT_XLSX_ROW_CAP = 5000;

/** Rows fetched per DataPurgeModel.streamTable round trip while building JSONL. */
const STREAM_PAGE_SIZE = 1000;

/**
 * `YYYYMMDD-HHmmss` for the current instant, local server time — matches
 * the filename pattern (`app-backup_<scopeSlug>_<timestamp>.zip`).
 *
 * @returns {string}
 * @private
 */
function _timestampSlug() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
}

/**
 * Builds the `<scopeSlug>` filename segment — the requested groups (or, for
 * a pure sub-table selection, "custom") joined with `+`, lowercased, so the
 * filename hints at scope without needing to open the archive.
 *
 * @param {{ requestedGroups: string[] }} scope
 * @returns {string}
 * @private
 */
function _buildScopeSlug(scope) {
    if (scope.requestedGroups.length > 0) {
        return scope.requestedGroups.map((g) => g.replace(/_$/, "").toLowerCase()).join("+");
    }
    return "custom";
}

/** Valid `manifest.trigger` values — the ONLY three this feature ever writes. */
const BACKUP_TRIGGERS = Object.freeze(["SCHEDULED", "MANUAL", "PURGE"]);

/**
 * ISO-8601 instant with the sub-second component stripped
 * (`2026-07-28T05:59:59Z`, never `...59.123Z`) — keeps `archiveId` stable to the second
 * (filesystem-timestamp granularity), never sub-second noise.
 *
 * @param {Date} [at]
 * @returns {string}
 * @private
 */
function _isoNoMillis(at = new Date()) {
    return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

class BackupArchiveService {
    /**
     * Builds the `archiveId` for a manifest (e.g.
     * `"bk_2026-07-28T05:59:59Z_e142_NIGHTLY"`). Pure and
     * deterministic given its inputs — callers that need to reference this
     * ID before the archive is fully built (e.g. `BackupStoreService`
     * computing `chain.baseArchiveId` for a new FULL) call this FIRST and
     * pass the result into `buildBackup`/`buildScheduledBackup` explicitly,
     * rather than letting archive-building invent its own ID (which would
     * make that forward reference impossible).
     *
     * @param {object} params
     * @param {"SCHEDULED"|"MANUAL"|"PURGE"} params.trigger
     * @param {string|null} [params.event] - a registered schedule event name | null.
     * @param {number|string|null} [params.eventId]
     * @param {Date} [params.at] - Defaults to `new Date()` — pass explicitly in tests for determinism.
     * @returns {string}
     * @throws {Error} When `trigger` is not one of {@link BACKUP_TRIGGERS}.
     *
     * @example
     * BackupArchiveService.buildArchiveId({ trigger: "SCHEDULED", event: "NIGHTLY", eventId: 142 });
     * // -> "bk_2026-07-28T05:59:59Z_e142_NIGHTLY"
     * BackupArchiveService.buildArchiveId({ trigger: "MANUAL" });
     * // -> "bk_2026-07-28T05:59:59Z_manual"
     */
    static buildArchiveId({ trigger, event = null, eventId = null, at = new Date() }) {
        if (!BACKUP_TRIGGERS.includes(trigger)) {
            throw new Error(`BackupArchiveService.buildArchiveId: trigger must be one of [${BACKUP_TRIGGERS.join(", ")}], got "${trigger}".`);
        }
        const iso = _isoNoMillis(at);
        if (trigger === "SCHEDULED" && eventId != null && event) {
            return `bk_${iso}_e${eventId}_${event}`;
        }
        return `bk_${iso}_${trigger.toLowerCase()}`;
    }

    /**
     * Shared read path for both {@link BackupArchiveService.buildBackup} and
     * {@link BackupArchiveService.buildScheduledBackup}:
     * streams every table through {@link DataPurgeModel.streamAllTables} —
     * ONE connection, ONE `SET TRANSACTION READ ONLY` transaction — computing
     * a per-table SHA-256 as a RUNNING hash while each batch streams past
     * (`hash.update()` is called once per batch, INSIDE the streaming
     * callback; this method never assembles a whole table into one buffer
     * purely to hash it — a log table can reach millions of rows).
     *
     * On `err.isSnapshotTooOld` (checked as a boolean flag — NEVER by
     * sniffing `err.message` for "ORA-01555", per the model's documented
     * contract) it discards any partially-accumulated state and re-reads
     * EVERY table from scratch via the pre-existing per-table
     * `DataPurgeModel.streamTable` path — a mixed
     * "some tables read-consistent, some not" result would be worse than
     * either pure state, so there is no partial-resume.
     *
     * Every table's JSONL "lines" are also accumulated here (needed to build
     * `data/<TABLE>.jsonl` for a table that turns out `INCLUDED`) — a table
     * that turns out `UNCHANGED` (decided by the caller via
     * `opts.previousTableState`, only when `opts.mode === "INCREMENTAL"`)
     * simply has its accumulated lines discarded and a pointer written
     * instead; the read (and therefore the hash) still had to happen either
     * way (documented tradeoff — this saves DISK, not query
     * time).
     *
     * @param {string[]} tables
     * @param {object} opts
     * @param {"FULL"|"INCREMENTAL"} opts.mode - `"INCREMENTAL"` is the only mode that ever consults `previousTableState`.
     * @param {Record<string, { sha256: string, sourceArchiveId: string }>} [opts.previousTableState] - Resolved chain state (BackupStoreService's job) — table -> where its data currently lives.
     * @param {string} [opts.archiveIdForLogging] - Only used in log lines, never affects behaviour.
     * @returns {Promise<{
     *   readConsistent: boolean,
     *   tables: Record<string, { state: "INCLUDED"|"UNCHANGED", rows: number, sha256: string, sourceArchiveId?: string }>,
     *   dataBuffers: Record<string, Buffer>,
     *   totalRows: number,
     *   highWater: Record<string, string>,
     * }>} `highWater` — max streamed PK (exact-digit string, "0" when empty) per `appendOnlyLog` table.
     * @throws {Error} Any non-`isSnapshotTooOld` failure from `DataPurgeModel.streamAllTables`/`streamTable` propagates unchanged.
     * @private
     */
    static async _streamAndHashTables(tables, opts) {
        const mode = opts.mode;
        const previousTableState = opts.previousTableState ?? {};
        const archiveIdForLogging = opts.archiveIdForLogging ?? "(unlabelled)";

        // Append-only log tables track the highest PK actually streamed. BigInt
        // because identifier PKs arrive as exact-digit strings (TO_CHAR) and
        // may exceed 2^53; a lexical max would also rank "9" above "10".
        const appendOnlyPk = new Map(
            tables.map((t) => getEntry(t)).filter((e) => e?.appendOnlyLog).map((e) => [e.table, e.pk]),
        );
        const freshAccumulators = () =>
            new Map(tables.map((t) => [t, { hash: crypto.createHash("sha256"), lines: [], rowCount: 0, maxPk: 0n }]));
        let acc = freshAccumulators();

        const onBatchFor = (table) => (rows) => {
            touch("backup-batch");
            const a = acc.get(table);
            const pkCol = appendOnlyPk.get(table);
            for (const row of rows) {
                const line = JSON.stringify(row) + "\n";
                a.hash.update(line);
                a.lines.push(line);
                a.rowCount += 1;
                if (pkCol && row[pkCol] != null) {
                    const pk = BigInt(String(row[pkCol]));
                    if (pk > a.maxPk) a.maxPk = pk;
                }
            }
        };

        let readConsistent = true;
        try {
            await DataPurgeModel.streamAllTables(tables, {
                onBatch: (table, rows) => onBatchFor(table)(rows),
            });
        } catch (err) {
            if (!err?.isSnapshotTooOld) throw err;
            readConsistent = false;
            logger.notice(dataBackupMessages.ARCHIVE_READ_FALLBACK(archiveIdForLogging, tables));
            // Discard whatever streamAllTables managed to accumulate before
            // it failed — re-read EVERY table from scratch via the
            // per-table path so the result is either fully read-consistent
            // or fully not, never a mix.
            acc = freshAccumulators();
            for (const table of tables) {
                // Sequential fallback reads, mirrors the pre-existing buildBackup loop.
                await DataPurgeModel.streamTable(table, { onBatch: onBatchFor(table) });
            }
        }

        const tablesManifest = {};
        const dataBuffers = {};
        const highWater = {};
        let totalRows = 0;
        for (const table of tables) {
            const a = acc.get(table);
            if (appendOnlyPk.has(table)) highWater[table] = a.maxPk.toString();
            const sha256 = a.hash.digest("hex");
            totalRows += a.rowCount;
            const prev = previousTableState[table];
            const unchanged = mode === "INCREMENTAL" && prev && prev.sha256 === sha256 && prev.sourceArchiveId;
            if (unchanged) {
                tablesManifest[table] = { state: "UNCHANGED", rows: a.rowCount, sha256, sourceArchiveId: prev.sourceArchiveId };
            } else {
                tablesManifest[table] = { state: "INCLUDED", rows: a.rowCount, sha256 };
                dataBuffers[`data/${table}.jsonl`] = Buffer.from(a.lines.join(""), "utf8");
            }
        }

        return { readConsistent, tables: tablesManifest, dataBuffers, totalRows, highWater };
    }
    /**
     * Builds a full backup archive for a resolved scope and issues the
     * backup token that gates `/execute`.
     *
     * @param {object} params
     * @param {object} params.selection      - `{ groups, tables }` — re-resolved here via `DataPurgeService.resolveScope`, never trusted pre-resolved.
     * @param {number|string} params.adminId - Issuing admin's numeric id (T_ADMINS_DEV.ID) — the token is bound to this identity.
     * @param {string|null} [params.requestId]
     * @returns {Promise<{
     *   zipBuffer: Buffer,
     *   filename: string,
     *   token: string,
     *   expiresAt: number,
     *   confirmPhrase: string,
     *   totalRows: number,
     *   tableCount: number,
     *   rowCounts: Record<string, number>,
     * }>}
     * @throws {AppError} Propagated from `DataPurgeService.resolveScope`.
     *
     * @example
     * const backup = await BackupArchiveService.buildBackup({
     *     selection: { tables: ["T_CREDIT_LIMIT"] },
     *     adminId: 10234,
     *     requestId: req.id,
     * });
     */
    static async buildBackup({ selection, adminId, requestId = null }) {
        const scope = DataPurgeService.resolveScope(selection);
        const startedAt = Date.now();
        const archiveId = BackupArchiveService.buildArchiveId({ trigger: "PURGE" });
        logger.info(dataPurgeMessages.BACKUP_STARTED(adminId, scope.scopeHash, scope.tables.length));

        // ── 1. Stream every table, read-consistently, hashing as we go ──────
        // Never joins/dedups against the scheduled-backup chain —
        // mode: "FULL" is passed unconditionally below, so
        // _streamAndHashTables' UNCHANGED branch can never trigger here even
        // though no previousTableState is supplied either.
        const { readConsistent, tables: tablesManifest, dataBuffers, totalRows, highWater } =
            await BackupArchiveService._streamAndHashTables(scope.tables, {
                mode: "FULL",
                archiveIdForLogging: archiveId,
            });
        // tableRowCounts / rowCounts (existing field name + shape — DataRestoreService
        // and _buildReadableWorkbook both key off this) derived from the new
        // per-table map, never a second independent count.
        const rowCounts = Object.fromEntries(Object.entries(tablesManifest).map(([t, s]) => [t, s.rows]));

        const fidelityNotes = DataPurgeService.buildFidelityNotes(scope.tables);

        // ── 2. manifest.json ─────────────────────────────────────────────────
        const manifest = {
            // NEW fields — purely additive; every field below this
            // comment already existed and DataRestoreService's `_preflight`
            // depends on it unchanged (kind / scope.tables / scopeHash / etc.).
            archiveId,
            trigger: "PURGE",
            event: null,
            eventId: null,
            mode: "FULL",
            readConsistent,
            chain: null, // never a chain base, never dedups
            tables: tablesManifest,
            // EXISTING fields — unchanged shape.
            kind: "FULL_SCOPE", // ENTITY-kind archives (Access Control revoke-backup) are a later phase — not built here.
            scope: {
                requestedGroups: scope.requestedGroups,
                requestedTables: scope.requestedTables,
                autoIncludedGroups: scope.autoIncludedGroups,
                tables: scope.tables,
            },
            scopeHash: scope.scopeHash,
            tableRowCounts: rowCounts,
            schemaVersion: SCHEMA_VERSION,
            createdBy: adminId,
            createdAt: new Date().toISOString(),
            requestId,
            appVersion: APP_VERSION,
            fidelityNotes,
        };
        const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");

        // ── 3. readable/backup-summary.xlsx (human-eyeball copy ONLY) ───────
        const xlsxBuffer = await BackupArchiveService._buildReadableWorkbook(scope.tables, rowCounts);

        // ── 4. signature.json — HMAC over the sorted file→SHA-256 map ───────
        const filesToHash = { "manifest.json": manifestBuffer, ...dataBuffers };
        const fileHashes = {};
        for (const [name, buf] of Object.entries(filesToHash)) {
            fileHashes[name] = crypto.createHash("sha256").update(buf).digest("hex");
        }
        // signRecord's buildPayload sorts keys alphabetically — exactly the
        // "sorted file→sha256 map" the signature.json format calls for.
        const digest = await CryptoVault.signRecord("APP_BACKUP_ARCHIVE", fileHashes);
        const signature = {
            algorithm: "HMAC-SHA256",
            domain: "APP_BACKUP_ARCHIVE",
            files: fileHashes,
            digest,
            createdAt: new Date().toISOString(),
        };
        const signatureBuffer = Buffer.from(JSON.stringify(signature, null, 2), "utf8");

        // ── 5. Zip everything ────────────────────────────────────────────────
        const zipBuffer = await BackupArchiveService._buildZip({
            "manifest.json": manifestBuffer,
            "signature.json": signatureBuffer,
            ...dataBuffers,
            "readable/backup-summary.xlsx": xlsxBuffer,
        });

        // ── 6. Issue the backup token ────────────────────────────────────────
        const { token, expiresAt } = await BackupTokenService.issue({
            adminId,
            scopeHash: scope.scopeHash,
            rowCounts,
            highWater,
        });
        logger.info(dataPurgeMessages.BACKUP_TOKEN_ISSUED(adminId, scope.scopeHash, new Date(expiresAt).toISOString()));

        const durationMs = Date.now() - startedAt;
        logger.info(dataPurgeMessages.BACKUP_COMPLETE(adminId, scope.scopeHash, totalRows, durationMs));

        const groupsInScope = [...new Set(scope.tables.map((t) => getEntry(t).group))];
        const filename = `app-backup_${_buildScopeSlug(scope)}_${_timestampSlug()}.zip`;

        return {
            zipBuffer,
            filename,
            token,
            expiresAt,
            confirmPhrase: DataPurgeService.buildConfirmPhrase(groupsInScope, totalRows),
            totalRows,
            tableCount: scope.tables.length,
            rowCounts,
        };
    }

    // ─── Scheduled / manual whole-DB backups ──

    /**
     * Builds ONE chain-aware backup archive for the SCHEDULED DB BACKUP
     * feature — distinct from {@link BackupArchiveService.buildBackup} (the
     * purge-gating backup: always FULL, never joins the chain) and
     * {@link BackupArchiveService.buildEntityBackup} (ENTITY-kind, Access
     * Control revoke). The caller (`BackupStoreService` — filesystem layout,
     * index, chain resolution) decides `mode`/`chain`/`previousTableState`
     * BEFORE calling this; this method's only job is to read the tables,
     * hash them, decide per-table INCLUDED vs UNCHANGED against whatever
     * `previousTableState` it was handed, and produce a signed zip. It has
     * no knowledge of the filesystem, the index, or any other archive.
     *
     * Produces a `manifest.kind: "FULL_SCOPE"` archive with the SAME
     * `scope`/`scopeHash`/`schemaVersion` shape `buildBackup` produces, so a
     * MATERIALISED (self-contained FULL) copy of one of these archives is
     * restorable through the exact same `DataRestoreService` path — no
     * second restore code path for this feature.
     *
     * @param {object} params
     * @param {string[]} params.tables - Registry table names (e.g. `getAllTableNames()`) — validated downstream by `DataPurgeModel`.
     * @param {"SCHEDULED"|"MANUAL"|"PURGE"} params.trigger
     * @param {string|null} [params.event] - a registered schedule event name | null for MANUAL/PURGE.
     * @param {number|string|null} [params.eventId]
     * @param {"FULL"|"INCREMENTAL"} params.mode
     * @param {string} params.archiveId - Pre-computed via {@link BackupArchiveService.buildArchiveId} — see that method's doc comment for why this is caller-supplied, not self-generated.
     * @param {{ baseArchiveId: string, generation: number }|null} [params.chain] - Required (non-null) when `mode === "INCREMENTAL"`; ignored for `"FULL"` (this method always writes `{ baseArchiveId: archiveId, generation: 0 }` for a FULL archive — the new archive IS its own chain's base).
     * @param {Record<string, { sha256: string, sourceArchiveId: string }>} [params.previousTableState] - Ignored when `mode === "FULL"`.
     * @param {number|string|null} [params.createdBy] - Acting admin numeric id for MANUAL, `null` for SCHEDULED/system-triggered.
     * @param {string|null} [params.requestId]
     * @returns {Promise<{
     *   zipBuffer: Buffer,
     *   manifest: object,
     *   archiveId: string,
     *   totalRows: number,
     *   tableCount: number,
     *   includedCount: number,
     *   unchangedCount: number,
     * }>}
     * @throws {Error} When `mode` is not `"FULL"`/`"INCREMENTAL"`, or `tables` is empty. Propagates any non-`isSnapshotTooOld` read failure.
     *
     * @example
     * const built = await BackupArchiveService.buildScheduledBackup({
     *     tables: getAllTableNames(),
     *     trigger: "SCHEDULED",
     *     event: "NIGHTLY",
     *     eventId: 142,
     *     mode: "INCREMENTAL",
     *     archiveId: "bk_2026-07-28T05:59:59Z_e142_NIGHTLY",
     *     chain: { baseArchiveId: "bk_2026-07-02T06:14:59Z_e140_NIGHTLY", generation: 3 },
     *     previousTableState: { T_AUDIT_LOGS_DEV: { sha256: "…", sourceArchiveId: "bk_…" } },
     * });
     */
    static async buildScheduledBackup({
        tables,
        trigger,
        event = null,
        eventId = null,
        mode,
        archiveId,
        chain = null,
        previousTableState = {},
        createdBy = null,
        requestId = null,
    }) {
        if (!Array.isArray(tables) || tables.length === 0) {
            throw new Error("BackupArchiveService.buildScheduledBackup: `tables` must be a non-empty array.");
        }
        if (!BACKUP_TRIGGERS.includes(trigger)) {
            throw new Error(`BackupArchiveService.buildScheduledBackup: trigger must be one of [${BACKUP_TRIGGERS.join(", ")}].`);
        }
        if (mode !== "FULL" && mode !== "INCREMENTAL") {
            throw new Error('BackupArchiveService.buildScheduledBackup: mode must be "FULL" or "INCREMENTAL".');
        }
        if (!archiveId || typeof archiveId !== "string") {
            throw new Error("BackupArchiveService.buildScheduledBackup: `archiveId` is required (build it via buildArchiveId()).");
        }

        const startedAt = Date.now();
        logger.info(dataBackupMessages.SCHEDULED_BUILD_STARTED(archiveId, trigger, tables.length));

        const { readConsistent, tables: tablesManifest, dataBuffers, totalRows } =
            await BackupArchiveService._streamAndHashTables(tables, {
                mode,
                previousTableState,
                archiveIdForLogging: archiveId,
            });

        const includedCount = Object.values(tablesManifest).filter((t) => t.state === "INCLUDED").length;
        const unchangedCount = Object.values(tablesManifest).filter((t) => t.state === "UNCHANGED").length;

        // trigger === "PURGE" NEVER gets a chain object at all — not even a
        // self-referencing one — it must never be mistakable for a valid
        // chain base a future SCHEDULED/MANUAL archive could dedup against.
        // `BackupStoreService._chainHead` also independently
        // excludes trigger:"PURGE" entries from head candidacy — this is
        // belt-and-braces at the manifest level too.
        const resolvedChain =
            trigger === "PURGE"
                ? null
                : mode === "FULL"
                  ? { baseArchiveId: archiveId, generation: 0 }
                  : { baseArchiveId: chain?.baseArchiveId ?? null, generation: chain?.generation ?? 0 };

        const fidelityNotes = DataPurgeService.buildFidelityNotes(tables);
        const scopeHash = crypto.createHash("sha256").update([...tables].sort().join(",")).digest("hex");

        const manifest = {
            archiveId,
            trigger,
            event,
            eventId,
            mode,
            readConsistent,
            chain: resolvedChain,
            tables: tablesManifest,
            // Same shape as buildBackup's manifest — a materialised copy of
            // this archive must be restorable through the SAME
            // DataRestoreService._preflight path, unmodified.
            kind: "FULL_SCOPE",
            scope: {
                requestedGroups: [],
                requestedTables: tables,
                autoIncludedGroups: [],
                tables,
            },
            scopeHash,
            tableRowCounts: Object.fromEntries(Object.entries(tablesManifest).map(([t, s]) => [t, s.rows])),
            schemaVersion: SCHEMA_VERSION,
            createdBy,
            createdAt: new Date().toISOString(),
            requestId,
            appVersion: APP_VERSION,
            fidelityNotes,
        };
        const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");

        // signature.json covers whatever files THIS archive actually
        // contains — manifest.json + only the INCLUDED data/*.jsonl files.
        // An UNCHANGED table's omitted file is exactly that: omitted, never
        // hashed as if present.
        const filesToHash = { "manifest.json": manifestBuffer, ...dataBuffers };
        const fileHashes = {};
        for (const [name, buf] of Object.entries(filesToHash)) {
            fileHashes[name] = crypto.createHash("sha256").update(buf).digest("hex");
        }
        const digest = await CryptoVault.signRecord("APP_BACKUP_ARCHIVE", fileHashes);
        const signature = {
            algorithm: "HMAC-SHA256",
            domain: "APP_BACKUP_ARCHIVE",
            files: fileHashes,
            digest,
            createdAt: new Date().toISOString(),
        };
        const signatureBuffer = Buffer.from(JSON.stringify(signature, null, 2), "utf8");

        // No readable/backup-summary.xlsx here — this is the on-disk STORAGE
        // artifact, which for an INCREMENTAL archive is never handed to an
        // operator directly (download/email always call
        // BackupStoreService.materialise() first). Re-reading every table a
        // second time just to build a preview sheet nobody looks at for an
        // artifact that lives only on the server would defeat the whole
        // point of read-consistent, single-pass streaming for
        // multi-million-row tables. materialise() builds its own summary
        // sheet from the (already fully resolved) rows it assembles.
        const zipBuffer = await BackupArchiveService._buildZip({
            "manifest.json": manifestBuffer,
            "signature.json": signatureBuffer,
            ...dataBuffers,
        });

        const durationMs = Date.now() - startedAt;
        logger.info(dataBackupMessages.SCHEDULED_BUILD_COMPLETE(archiveId, mode, includedCount, unchangedCount, totalRows, durationMs));

        return {
            zipBuffer,
            manifest,
            archiveId,
            totalRows,
            tableCount: tables.length,
            includedCount,
            unchangedCount,
        };
    }

    // ─── ENTITY-kind archives ────────

    /**
     * Deterministic HMAC-independent fingerprint binding an ENTITY-kind
     * archive/token to BOTH the specific subject (`entity.table` +
     * `entity.keyColumn` + `entity.keyValue`) AND its exact table set.
     *
     * This is what closes the gap a plain `scopeHash` (table-set-only, as
     * used by `resolveScope`'s FULL_SCOPE hash) would leave open: two
     * different admins' revoke-backups cover the IDENTICAL tables, so a
     * table-set-only hash could not tell "a backup for admin A" apart from "a
     * backup for admin B" — an operator could download A's backup and use its
     * token to revoke/delete B. Folding `entity.keyValue` into the hash makes
     * the backup token cryptographically bound to the one admin it was issued
     * for (`AdminManagementService._verifyRevokeBackupToken` recomputes this
     * SAME hash from the request's `:username` and compares).
     *
     * NOT itself a security boundary on its own — the outer backup token's
     * HMAC (`BackupTokenService`) is. This is purely the fingerprint carried
     * *inside* that HMAC-signed payload.
     *
     * @param {{ table: string, keyColumn: string, keyValue: string|number }} entity
     * @param {string[]} tables - The archive's full table list (any order — sorted internally).
     * @returns {string} 64-char hex SHA-256 digest.
     *
     * @example
     * BackupArchiveService.computeEntityScopeHash(
     *     { table: "T_ADMINS_DEV", keyColumn: "USERNAME", keyValue: "jdoe" },
     *     BackupArchiveService.ADMIN_REVOKE_BACKUP_TABLES,
     * );
     */
    static computeEntityScopeHash(entity, tables) {
        const sortedTables = [...new Set(tables)].sort();
        return crypto
            .createHash("sha256")
            .update(`${entity.table}:${entity.keyColumn}:${entity.keyValue}|${sortedTables.join(",")}`)
            .digest("hex");
    }

    /**
     * Builds an ENTITY-kind backup archive scoped to the rows
     * belonging to ONE subject across several tables, rather than a full
     * table scan — the Access Control revoke-backup flow is the
     * only caller today: `AdminManagementService.buildRevokeBackup` passes
     * one filter descriptor per table ("this admin's rows in this table").
     *
     * Reuses every private helper `buildBackup` uses (`_buildZip`,
     * `CryptoVault.signRecord`, `BackupTokenService.issue`) — this is an
     * ADDITIONAL entry point into the SAME archive machinery, not a fork of
     * it. The only structural differences from `buildBackup` are (a) rows are
     * fetched via `DataPurgeModel.streamTableFiltered` instead of the
     * unfiltered `streamTable`, and (b) the manifest's `kind`/`entity`/
     * `scopeHash` reflect the ENTITY shape instead of FULL_SCOPE.
     *
     * @param {object} params
     * @param {{ table: string, keyColumn: string, keyValue: string|number }} params.entity - Written verbatim into `manifest.entity`.
     * @param {Array<{ table: string, whereColumns: string[], whereValue: string|number }>} params.tableFilters - One entry per table to include; `whereColumns` OR'd together against `whereValue` (see `DataPurgeModel.streamTableFiltered`).
     * @param {number|string} params.adminId - The ACTING admin (the caller downloading this backup) — the token is bound to this identity, exactly like `buildBackup`.
     * @param {string|null} [params.requestId]
     * @returns {Promise<{
     *   zipBuffer: Buffer,
     *   filename: string,
     *   token: string,
     *   expiresAt: number,
     *   totalRows: number,
     *   tableCount: number,
     *   rowCounts: Record<string, number>,
     *   scopeHash: string,
     * }>}
     *
     * @example
     * const backup = await BackupArchiveService.buildEntityBackup({
     *     entity: { table: "T_ADMINS_DEV", keyColumn: "USERNAME", keyValue: "jdoe" },
     *     tableFilters: [
     *         { table: "T_ADMINS_DEV", whereColumns: ["USERNAME"], whereValue: "jdoe" },
     *         { table: "T_AUDIT_LOGS_DEV", whereColumns: ["USERNAME"], whereValue: "jdoe" },
     *     ],
     *     adminId: 10777,
     *     requestId: req.id,
     * });
     */
    static async buildEntityBackup({ entity, tableFilters, adminId, requestId = null }) {
        const startedAt = Date.now();
        const tables = tableFilters.map((f) => f.table);
        const scopeHash = BackupArchiveService.computeEntityScopeHash(entity, tables);
        logger.info(dataPurgeMessages.BACKUP_STARTED(adminId, scopeHash, tables.length));

        const rowCounts = {};
        /** @type {Record<string, object[]>} */
        const rowsByTable = {};
        /** @type {Record<string, Buffer>} */
        const dataBuffers = {};

        for (const filter of tableFilters) {
            const entry = getEntry(filter.table);
            const rows = [];
            const count = await DataPurgeModel.streamTableFiltered(filter.table, {
                pageSize: STREAM_PAGE_SIZE,
                whereColumns: filter.whereColumns,
                whereValue: filter.whereValue,
                onBatch: (batchRows) => {
                    for (const row of batchRows) rows.push(row);
                },
            });
            rowCounts[filter.table] = count;
            rowsByTable[filter.table] = rows;
            const jsonl = rows.length > 0 ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
            dataBuffers[`data/${entry.table}.jsonl`] = Buffer.from(jsonl, "utf8");
        }

        const totalRows = Object.values(rowCounts).reduce((sum, n) => sum + n, 0);
        const fidelityNotes = DataPurgeService.buildFidelityNotes(tables);

        const manifest = {
            kind: "ENTITY",
            entity,
            scope: { requestedGroups: [], requestedTables: tables, autoIncludedGroups: [], tables },
            scopeHash,
            tableRowCounts: rowCounts,
            schemaVersion: SCHEMA_VERSION,
            createdBy: adminId,
            createdAt: new Date().toISOString(),
            requestId,
            appVersion: APP_VERSION,
            fidelityNotes,
        };
        const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");

        const xlsxBuffer = await BackupArchiveService._buildReadableWorkbookFromRows(tables, rowsByTable);

        const filesToHash = { "manifest.json": manifestBuffer, ...dataBuffers };
        const fileHashes = {};
        for (const [name, buf] of Object.entries(filesToHash)) {
            fileHashes[name] = crypto.createHash("sha256").update(buf).digest("hex");
        }
        const digest = await CryptoVault.signRecord("APP_BACKUP_ARCHIVE", fileHashes);
        const signature = {
            algorithm: "HMAC-SHA256",
            domain: "APP_BACKUP_ARCHIVE",
            files: fileHashes,
            digest,
            createdAt: new Date().toISOString(),
        };
        const signatureBuffer = Buffer.from(JSON.stringify(signature, null, 2), "utf8");

        const zipBuffer = await BackupArchiveService._buildZip({
            "manifest.json": manifestBuffer,
            "signature.json": signatureBuffer,
            ...dataBuffers,
            "readable/backup-summary.xlsx": xlsxBuffer,
        });

        const { token, expiresAt } = await BackupTokenService.issue({ adminId, scopeHash, rowCounts });
        logger.info(dataPurgeMessages.BACKUP_TOKEN_ISSUED(adminId, scopeHash, new Date(expiresAt).toISOString()));

        const durationMs = Date.now() - startedAt;
        logger.info(dataPurgeMessages.BACKUP_COMPLETE(adminId, scopeHash, totalRows, durationMs));

        const filename = `app-backup_admin-${entity.keyValue}_${_timestampSlug()}.zip`;

        return { zipBuffer, filename, token, expiresAt, totalRows, tableCount: tables.length, rowCounts, scopeHash };
    }

    // ─── Private builders ────────────────────────────────────────────────────

    /**
     * Builds the human-eyeball `readable/backup-summary.xlsx` — one sheet
     * per table (rows capped at `BACKUP_XLSX_ROW_CAP`) plus a Summary
     * sheet. NEVER parsed on restore — see file header.
     *
     * @param {string[]} tables
     * @param {Record<string, number>} rowCounts
     * @returns {Promise<Buffer>}
     * @private
     */
    static async _buildReadableWorkbook(tables, rowCounts) {
        const rowCap = parseInt(process.env.BACKUP_XLSX_ROW_CAP, 10) || DEFAULT_XLSX_ROW_CAP;

        const workbook = new ExcelJS.Workbook();
        workbook.creator = `${process.env.APP_NAME || "CATHERINE"} System`;
        workbook.created = new Date();

        const summary = workbook.addWorksheet("Summary");
        summary.columns = [
            { header: "Table", key: "table", width: 32 },
            { header: "Row Count", key: "rowCount", width: 14 },
            { header: "Included in this sheet", key: "capped", width: 24 },
        ];
        summary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        summary.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF4208" } };

        for (const table of tables) {
            const rowCount = rowCounts[table] ?? 0;
            summary.addRow({
                table,
                rowCount,
                capped: rowCount > rowCap ? `First ${rowCap} of ${rowCount}` : "All rows",
            });

            const sheet = workbook.addWorksheet(table.length > 31 ? table.slice(0, 31) : table);
            let headerWritten = false;
            let written = 0;

            await DataPurgeModel.streamTable(table, {
                pageSize: STREAM_PAGE_SIZE,
                onBatch: (rows) => {
                    if (written >= rowCap) return;
                    if (!headerWritten && rows.length > 0) {
                        sheet.columns = Object.keys(rows[0]).map((col) => ({ header: col, key: col, width: 18 }));
                        sheet.getRow(1).font = { bold: true };
                        headerWritten = true;
                    }
                    for (const row of rows) {
                        if (written >= rowCap) break;
                        // Date columns only: the eyeball copy must show the
                        // stored wall clock, not ExcelJS's UTC re-read of it
                        // (the JSONL beside it stays the restore source and
                        // is untouched by presentation).
                        addNormalizedRow(sheet, row);
                        written++;
                    }
                },
            });
        }

        return workbook.xlsx.writeBuffer();
    }

    /**
     * Same output shape as `_buildReadableWorkbook`, but for ENTITY-kind
     * archives whose rows are already fully materialised in memory (they are
     * a handful of rows for one admin, not a full table — no need to
     * re-stream from Oracle a second time via `DataPurgeModel`).
     *
     * @param {string[]} tables
     * @param {Record<string, object[]>} rowsByTable
     * @returns {Promise<Buffer>}
     * @private
     */
    static async _buildReadableWorkbookFromRows(tables, rowsByTable) {
        const rowCap = parseInt(process.env.BACKUP_XLSX_ROW_CAP, 10) || DEFAULT_XLSX_ROW_CAP;

        const workbook = new ExcelJS.Workbook();
        workbook.creator = `${process.env.APP_NAME || "CATHERINE"} System`;
        workbook.created = new Date();

        const summary = workbook.addWorksheet("Summary");
        summary.columns = [
            { header: "Table", key: "table", width: 32 },
            { header: "Row Count", key: "rowCount", width: 14 },
            { header: "Included in this sheet", key: "capped", width: 24 },
        ];
        summary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        summary.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF4208" } };

        for (const table of tables) {
            const rows = rowsByTable[table] ?? [];
            summary.addRow({
                table,
                rowCount: rows.length,
                capped: rows.length > rowCap ? `First ${rowCap} of ${rows.length}` : "All rows",
            });

            const sheet = workbook.addWorksheet(table.length > 31 ? table.slice(0, 31) : table);
            if (rows.length > 0) {
                sheet.columns = Object.keys(rows[0]).map((col) => ({ header: col, key: col, width: 18 }));
                sheet.getRow(1).font = { bold: true };
                for (const row of rows.slice(0, rowCap)) addNormalizedRow(sheet, row);
            }
        }

        return workbook.xlsx.writeBuffer();
    }

    /**
     * Streams a set of in-memory buffers into a single zip archive buffer
     * via `archiver` (same PassThrough-collect pattern as
     * `AuditLogService.exportToZip`).
     *
     * @param {Record<string, Buffer>} files - Path within the zip -> file content.
     * @returns {Promise<Buffer>}
     * @private
     */
    static async _buildZip(files) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            const pass = new PassThrough();
            pass.on("data", (chunk) => {
                touch("backup-zip");
                chunks.push(chunk);
            });
            pass.on("end", () => resolve(Buffer.concat(chunks)));
            pass.on("error", reject);

            const archive = archiver("zip", { zlib: { level: 9 } });
            archive.on("error", reject);
            archive.pipe(pass);

            for (const [name, buffer] of Object.entries(files)) {
                archive.append(buffer, { name });
            }

            archive.finalize();
        });
    }
}

module.exports = BackupArchiveService;
// SCHEMA_VERSION is exported (not just used internally) so DataRestoreService's
// manifest.schemaVersion check reads the SAME literal the backup side stamped
// into manifest.json — never a second hardcoded "v6" that could drift.
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
// The tables an Access Control revoke-backup covers — exported so
// AdminManagementService builds its tableFilters from this SAME list (never a
// second hardcoded copy) and so `_verifyRevokeBackupToken` recomputes
// `computeEntityScopeHash` over the identical table set the archive was built
// with. Every table must be registered in constants/purgeTables.js. A project
// adds the tables that record an admin as actor here.
//
// ⚠ Changing this list changes `computeEntityScopeHash`'s input — every
// backup token issued before the change stops validating.
module.exports.ADMIN_REVOKE_BACKUP_TABLES = Object.freeze([
    "T_ADMINS_DEV",
    "T_AUDIT_LOGS_DEV",
    "T_SERVER_ALERT_ACK_DEV",
]);
// The only 3 valid `manifest.trigger` values — exported so
// `BackupStoreService` validates against this SAME list rather than a second
// hardcoded copy that could drift.
module.exports.BACKUP_TRIGGERS = BACKUP_TRIGGERS;
