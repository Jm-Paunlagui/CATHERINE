"use strict";

/**
 * @fileoverview Data Purge & Restore — archive restore engine.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Parses and verifies a `.zip` backup archive produced by
 * `BackupArchiveService`, runs a read-only pre-flight (`POST
 * /restore/preview`), and — only after a fresh admin re-auth and confirm
 * phrase — performs the restore itself (`POST /restore`): an ordered,
 * FK-remapping, ROW_HASH-re-signing batch INSERT of every table the archive
 * covers, inside ONE atomic `Transaction`.
 *
 * An uploaded archive is UNTRUSTED INPUT. Every table name this file ever
 * acts on is re-validated against `purgeTables.js`'s registry allow-list
 * (and the `NEVER_PURGE` deny-list) BEFORE it is used for anything — a
 * manifest naming an unregistered table is rejected,
 * never executed (CWE-89). The archive's HMAC signature is verified before
 * any of its content is trusted for a decision (kind, table list, rows).
 *
 * HOW IT WORKS
 * ------------
 * `preview()` and `restore()` share two private steps so the two can never
 * diverge:
 *   1. `_verifyAndParseArchive(zipBuffer)` — unzips, recomputes the SHA-256
 *      of `manifest.json` + every `data/<TABLE>.jsonl` file actually present,
 *      and verifies the archive's HMAC digest (`CryptoVault.verifyRecord`,
 *      domain `APP_BACKUP_ARCHIVE`) over that recomputed file→hash map — a
 *      byte-flipped file, an edited `manifest.json` (which is where `kind`
 *      and `scope.tables` live), a stripped/added data file, or a forged
 *      digest all fail this the same way. Only once this passes are the
 *      parsed `manifest` object and per-table JSONL rows trusted at all.
 *   2. `_preflight({ manifest, dataByTable })` — NEVER writes. Validates
 *      `schemaVersion`, resolves + allow-list-validates `manifest.scope
 *      .tables`, enforces the archive's declared `kind` (`FULL_SCOPE` →
 *      every target table must be empty; `ENTITY` → only the archive's own
 *      natural key must be absent), and builds
 *      the fidelity report (`DataPurgeService.buildFidelityNotes` — shared,
 *      never restated — plus which tables get new identity PKs).
 *
 * `restore()` then runs ONE `Transaction`, inserting `getRestoreOrder()`'s
 * tables in tier order:
 *   - **FK remap** is driven ENTIRELY by each table's registry `fkEdges` —
 *     never a hardcoded "these 3 tables only" list. A parent table whose
 *     `isIdentity` is true gets an `oldPk -> newPk` map built from
 *     `DataPurgeModel.insertRestoreBatch`'s `returning` values; every LATER
 *     table's matching FK column is rewritten from that map before its own
 *     insert. Any identity parent is covered, whatever table it is.
 *   - **Restore tiers are load-bearing** when a table carries an INSERT
 *     trigger that writes another registered table: restore the trigger's
 *     source before its target so the trigger finds nothing to change. Set
 *     `restoreOrderTier` in the registry with that in mind.
 *   - **ROW_HASH re-sign** runs for EVERY table with a non-null
 *     `rowHashDomain` — including tables that sign a PARENT's FK, which ALSO
 *     changes on restore via the FK remap above; skipping them would leave
 *     those tables reading TAMPERED. The signed-field object always comes from
 *     `TamperDetectionService.buildSignedFields(domain, row)` — never a
 *     re-implementation — so the signer here and the Integrity Center
 *     verifier can never drift.
 *   - **Verify before re-sign (CWE-345).** Re-signing blindly would launder a
 *     forged ROW_HASH into a valid one. Before a row is re-signed its ORIGINAL
 *     ROW_HASH is verified against the row's ORIGINAL values (original PK and
 *     original FK values, i.e. before identity regeneration / FK remap). A valid
 *     row is re-signed as before; a row whose original hash is invalid or NULL is
 *     restored with ROW_HASH = NULL (it stays unverified, so the integrity checks
 *     still flag it), logged `TAMPER_DETECTED` (table + original PK only) and
 *     counted in `tamperedRowsRestoredUnsigned`. Generic over every table with a
 *     `rowHashDomain` - no per-table list.
 *
 * `insertMany`'s `returning` option is mutually exclusive with
 * `batchErrors` (oracle-mongo-wrapper, `OracleCollection.js`), so a failed
 * batch here rolls the WHOLE transaction back — the correct semantic for a
 * restore (a partially-restored table is worse than no restore at all).
 *
 * EXAMPLE
 * -------
 *   const report = await DataRestoreService.preview({ zipBuffer: req.file.buffer });
 *   // report.tablesGettingNewPks, report.fidelityNotes
 *
 *   const result = await DataRestoreService.restore({
 *       zipBuffer: req.file.buffer,
 *       adminId: req.user.id,
 *       adminPassword: req.body.adminPassword,
 *       confirmPhrase: req.body.confirmPhrase,
 *       clientIp: req.ip,
 *       requestId: req.id,
 *   });
 */

const crypto = require("crypto");
const JSZip = require("jszip");

const { AppError, PURGE_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const { dataPurgeMessages } = require("../constants/messages");
const {
    NEVER_PURGE,
    PURGE_POOL,
    getEntry,
    getRestoreOrder,
} = require("../constants/purgeTables");
const DataPurgeModel = require("../models/data-purge.model");
const DataPurgeService = require("./DataPurgeService");
// Required for BackupArchiveService.SCHEMA_VERSION ONLY — restore's
// schemaVersion check reads the SAME literal the backup side stamped into
// manifest.json, never a second hardcoded "v6" that could drift.
const BackupArchiveService = require("./BackupArchiveService");
const AuditLogModel = require("../models/audit.log.model");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const TamperDetectionService = require("./TamperDetectionService");
const { createDb, Transaction } = require("../utils/oracle-mongo-wrapper");
const { registry } = require("../middleware/cache");

// Explicit PURGE_POOL — NEVER a bare createDb() or a pool name derived from a
// request/parameter. The restore is a LONG-HOLD multi-table write, so like the
// purge it runs on the bulk pool and cannot starve interactive traffic.
const _db = createDb(PURGE_POOL);

/** Canonical text form of a signed TIMESTAMP(6) column (same as the purge export / TamperDetectionService). */
const CANONICAL_TS_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.FF6';

/** Default batch size when RESTORE_BATCH_SIZE is unset — mirrors .env.example. */
const DEFAULT_RESTORE_BATCH_SIZE = 500;

/**
 * @returns {number}
 * @private
 */
function _restoreBatchSize() {
    const n = parseInt(process.env.RESTORE_BATCH_SIZE, 10);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_RESTORE_BATCH_SIZE;
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 * @private
 */
function _chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

class DataRestoreService {
    // ─── Public entry points ────────────────────────────────────────────────

    /**
     * `POST /restore/preview` — verifies the archive's signature, runs the
     * FULL pre-flight (kind rule, fidelity report), and
     * returns the report. NEVER writes to the database.
     *
     * @param {object} params
     * @param {Buffer} params.zipBuffer - The uploaded `.zip` archive's raw bytes (`req.file.buffer`).
     * @returns {Promise<{
     *   tables: string[], kind: "FULL_SCOPE"|"ENTITY", entity: object|null,
     *   rowCounts: Record<string, number>, tablesGettingNewPks: string[],
     *   fidelityNotes: string[],
     *   archiveMeta: { createdBy: *, createdAt: string|null, requestId: string|null, appVersion: string|null, scopeHash: string|null },
     * }>}
     * @throws {AppError} 400/403/409/422 — see `_verifyAndParseArchive` / `_preflight`.
     *
     * @example
     * const report = await DataRestoreService.preview({ zipBuffer: req.file.buffer });
     */
    static async preview({ zipBuffer }) {
        const { manifest, dataByTable } =
            await DataRestoreService._verifyAndParseArchive(zipBuffer);
        const report = await DataRestoreService._preflight({
            manifest,
            dataByTable,
        });
        const totalRows = Object.values(report.rowCounts).reduce(
            (s, n) => s + n,
            0,
        );
        logger.info(
            dataPurgeMessages.RESTORE_PREVIEW_GENERATED(
                report.tables.length,
                totalRows,
            ),
        );
        return report;
    }

    /**
     * `POST /restore` — performs the restore end-to-end: re-verify the
     * caller + admin password, verify the archive (same pre-flight as
     * `preview()`), verify the confirm phrase, then run ONE atomic
     * `Transaction` that inserts every archived table in
     * `getRestoreOrder()` order with FK remap and ROW_HASH re-signing.
     *
     * @param {object} params
     * @param {Buffer} params.zipBuffer
     * @param {number|string} params.adminId - numeric id (`req.user.id`) of the authenticated SUPER_ADMIN caller.
     * @param {string} params.adminPassword - Plaintext password, verified via `CryptoVault.verifyAdminPassword`.
     * @param {string} params.confirmPhrase - Operator-typed phrase, compared against `buildConfirmPhrase`.
     * @param {string|null} [params.clientIp]
     * @param {string|null} [params.requestId]
     * @returns {Promise<{
     *   kind: string, tables: string[], totalInserted: number, totalResigned: number,
     *   perTable: Array<{ table: string, insertedCount: number, hashesResigned: number }>,
     *   durationMs: number, archiveMeta: object, fidelityNotes: string[],
     * }>}
     * @throws {AppError} 400/401/403/409/422 — see the individual step comments below.
     *
     * @example
     * const report = await DataRestoreService.restore({
     *     zipBuffer: req.file.buffer,
     *     adminId: req.user.id,
     *     adminPassword: req.body.adminPassword,
     *     confirmPhrase: req.body.confirmPhrase,
     *     clientIp: req.ip,
     *     requestId: req.id,
     * });
     */
    static async restore({
        zipBuffer,
        adminId,
        adminPassword,
        confirmPhrase,
        clientIp = null,
        requestId = null,
    }) {
        const startedAt = Date.now();

        // ── Step 0 — re-verify the caller + admin password (mirrors
        // DataPurgeService.executePurge's identical steps 1-2).
        const adminRecord = await DataPurgeService.findAdminById(adminId);
        if (!adminRecord) {
            throw new AppError(
                PURGE_ERRORS.ADMIN_NOT_FOUND,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                },
            );
        }
        if (!adminPassword) {
            throw new AppError(
                PURGE_ERRORS.ADMIN_PASSWORD_REQUIRED,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [{ field: "adminPassword", issue: "Required." }],
                },
            );
        }
        // CryptoVault.verifyAdminPassword, NOT verifyPassword — verifyPassword
        // routes by the global hash mode and can reject a correct admin password.
        const { matched: passwordOk } = await CryptoVault.verifyAdminPassword(
            adminPassword,
            adminRecord.PASSWORD,
        );
        if (!passwordOk) {
            logger.warning(
                dataPurgeMessages.RESTORE_PASSWORD_REJECTED(adminId),
            );
            throw new AppError(
                PURGE_ERRORS.INVALID_ADMIN_PASSWORD,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                },
            );
        }

        // ── Steps 1-3 — signature verify, parse, pre-flight. NEVER writes.
        const { manifest, dataByTable } =
            await DataRestoreService._verifyAndParseArchive(zipBuffer);
        const preflight = await DataRestoreService._preflight({
            manifest,
            dataByTable,
        });

        logger.info(
            dataPurgeMessages.RESTORE_STARTED(
                adminId,
                manifest.scopeHash ?? "unknown",
            ),
        );

        // ── Confirm phrase — RESTORE <GROUP_LIST> <rowCount> ROWS, built
        // from the SAME archive snapshot preview() would have shown. Unlike
        // purge's backup-token/live-recount gap, restore's "backup" IS the
        // uploaded file — there is no live-drift concept to guard against
        // here, so the row count is always the archive's own count.
        if (!confirmPhrase) {
            throw new AppError(
                PURGE_ERRORS.CONFIRM_PHRASE_REQUIRED,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [{ field: "confirmPhrase", issue: "Required." }],
                },
            );
        }
        const groupsInScope = [
            ...new Set(preflight.tables.map((t) => getEntry(t).group)),
        ];
        const totalArchiveRows = Object.values(preflight.rowCounts).reduce(
            (s, n) => s + n,
            0,
        );
        const expectedPhrase = DataRestoreService.buildConfirmPhrase(
            groupsInScope,
            totalArchiveRows,
        );
        if (String(confirmPhrase).trim() !== expectedPhrase) {
            logger.warning(
                dataPurgeMessages.RESTORE_CONFIRM_MISMATCH(adminId),
            );
            throw new AppError(
                PURGE_ERRORS.CONFIRM_PHRASE_MISMATCH,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "ValidationError",
                    hint: "Type the confirmation phrase exactly as shown, including capitalisation and punctuation.",
                },
            );
        }

        // ── Steps 4-6 — single atomic Transaction: ordered insert, FK
        // remap, ROW_HASH re-sign, commit.
        /** table -> Map<oldPkString, newPkNumber> — identity tables only. */
        const pkMaps = new Map();
        const perTable = [];
        let totalInserted = 0;
        let totalResigned = 0;
        let totalTampered = 0;

        const batchSize = _restoreBatchSize();
        const txManager = new Transaction(_db);

        await txManager.withTransaction(async (session) => {
            for (const entry of getRestoreOrder(preflight.tables)) {
                const archivedRows = dataByTable[entry.table] ?? [];
                if (archivedRows.length === 0) {
                    perTable.push({
                        table: entry.table,
                        insertedCount: 0,
                        hashesResigned: 0,
                        tamperedRowsRestoredUnsigned: 0,
                    });
                    continue;
                }

                // ── FK remap — driven ENTIRELY by entry.fkEdges + pkMaps.
                /** remapped row object -> the ORIGINAL archived row (pre identity regeneration / FK remap). */
                const originalOf = new Map();
                const remappedRows = archivedRows.map((row) => {
                    let out = row;
                    for (const edge of entry.fkEdges) {
                        const parentMap = pkMaps.get(edge.refTable);
                        if (!parentMap) continue; // parent's PK is natural (unchanged) or wasn't part of this restore
                        const oldVal = row[edge.column];
                        if (oldVal === null || oldVal === undefined) continue;
                        const newVal = parentMap.get(String(oldVal));
                        if (newVal === undefined) {
                            throw new Error(
                                `DataRestoreService: "${entry.table}"."${edge.column}" references "${edge.refTable}" value "${oldVal}", which was not found among the just-restored parent rows — the archive is internally inconsistent.`,
                            );
                        }
                        if (out === row) out = { ...row };
                        out[edge.column] = newVal;
                    }
                    originalOf.set(out, row);
                    return out;
                });

                let insertedCount = 0;
                const newPkMap = entry.isIdentity ? new Map() : null;
                /** @type {Array<{ row: object, original: object, newPk: number|string }>} */
                const insertedForResign = [];

                for (const batch of _chunk(remappedRows, batchSize)) {
                    // Batches must run sequentially inside one transaction.
                    const { insertedCount: n, returning } =
                        await DataPurgeModel.insertRestoreBatch(
                            entry.table,
                            batch,
                            session,
                        );
                    insertedCount += n;

                    if (entry.isIdentity) {
                        batch.forEach((row, idx) => {
                            const newPk = returning[idx]?.[entry.pk];
                            newPkMap.set(String(row[entry.pk]), newPk);
                            if (entry.rowHashDomain)
                                insertedForResign.push({ row, original: originalOf.get(row) ?? row, newPk });
                        });
                    } else if (entry.rowHashDomain) {
                        batch.forEach((row) =>
                            insertedForResign.push({
                                row,
                                original: originalOf.get(row) ?? row,
                                newPk: row[entry.pk],
                            }),
                        );
                    }
                }

                if (entry.isIdentity) pkMaps.set(entry.table, newPkMap);

                // ── ROW_HASH re-sign — ANY table with a non-null
                // rowHashDomain (see file header).
                let hashesResigned = 0;
                let tamperedUnsigned = 0;
                if (entry.rowHashDomain && insertedForResign.length > 0) {
                    const { signRows, tampered } =
                        await DataRestoreService._verifyThenSign(
                            entry,
                            insertedForResign,
                            session,
                        );
                    tamperedUnsigned = tampered;
                    for (const chunk of _chunk(signRows, batchSize)) {
                        await session
                            .collection(entry.table)
                            .bulkUpdateByKeys(chunk, { keys: [entry.pk] });
                    }
                    hashesResigned = signRows.length - tampered;
                }

                perTable.push({
                    table: entry.table,
                    insertedCount,
                    hashesResigned,
                    tamperedRowsRestoredUnsigned: tamperedUnsigned,
                });
                totalInserted += insertedCount;
                totalResigned += hashesResigned;
                totalTampered += tamperedUnsigned;
                logger.notice(
                    dataPurgeMessages.RESTORE_TABLE_STEP(
                        entry.table,
                        insertedCount,
                        hashesResigned,
                    ),
                );
            }
        });

        const durationMs = Date.now() - startedAt;
        logger.alert(
            dataPurgeMessages.RESTORE_COMMIT(
                adminId,
                manifest.scopeHash ?? "unknown",
                totalInserted,
                durationMs,
            ),
        );

        // ── Post-commit (outside the transaction) — audit trail + cache
        // flush, mirroring DataPurgeService.executePurge step 9. Best-effort:
        // neither failure here undoes the already-committed restore.
        DataRestoreService._writePostCommitAudit({
            adminId,
            manifest,
            preflight,
            perTable,
            totalInserted,
            durationMs,
            clientIp,
            requestId,
        }).catch((err) => {
            logger.error(
                dataPurgeMessages.RESTORE_POST_COMMIT_AUDIT_FAILED(err),
            );
        });

        registry.flushAll();
        logger.info(dataPurgeMessages.CACHE_FLUSHED());

        return {
            kind: preflight.kind,
            tables: preflight.tables,
            totalInserted,
            totalResigned,
            tamperedRowsRestoredUnsigned: totalTampered,
            perTable,
            durationMs,
            archiveMeta: preflight.archiveMeta,
            fidelityNotes: preflight.fidelityNotes,
        };
    }

    /**
     * Verify-then-sign step of the restore (CWE-345), shared by every table with
     * a `rowHashDomain`. For each inserted row:
     *   1. verify the ORIGINAL ROW_HASH over `buildSignedFields(domain, original)`
     *      (original PK and FK values, as archived);
     *   2. valid -> sign the NEW values (new PK, remapped FKs, and for
     *      `entry.canonicalTimestampColumns` the value the database now holds,
     *      read back as the canonical string);
     *   3. invalid / null original hash (or a signer error) -> `ROW_HASH = NULL`,
     *      `logger.security("TAMPER_DETECTED", { table, pk })` (no PII).
     *
     * Complexity: O(n) vault calls for n rows; one extra read per 1000 rows only
     * for tables that declare canonical timestamp columns.
     *
     * @param {import('../constants/purgeTables').PurgeTableEntry} entry
     * @param {Array<{ row: object, original: object, newPk: number|string }>} items
     * @param {{ execute: Function }} session - the restore transaction session
     * @returns {Promise<{ signRows: Array<object>, tampered: number }>} rows for bulkUpdateByKeys (ROW_HASH may be null)
     */
    static async _verifyThenSign(entry, items, session) {
        const domain = entry.rowHashDomain;
        const tsCols = entry.canonicalTimestampColumns ?? [];
        const canonical = new Map();
        if (tsCols.length > 0) {
            for (const group of _chunk(items, 1000)) {
                const binds = {};
                group.forEach(({ newPk }, i) => {
                    binds[`p${i}`] = newPk;
                });
                const list = group.map((_, i) => `:p${i}`).join(", ");
                // Identifiers come from the purgeTables registry (allow-list), values are binds.
                const cols = tsCols.map((c) => `TO_CHAR("${c}",'${CANONICAL_TS_FORMAT}') AS "${c}"`).join(", ");
                const res = await session.execute(
                    `SELECT "${entry.pk}", ${cols} FROM "${entry.table}" WHERE "${entry.pk}" IN (${list})`,
                    binds,
                    { outFormat: _db.oracledb.OUT_FORMAT_OBJECT },
                );
                for (const r of res?.rows ?? []) canonical.set(String(r[entry.pk]), r);
            }
        }

        let tampered = 0;
        const signRows = await Promise.all(
            items.map(async ({ row, original, newPk }) => {
                let valid = false;
                try {
                    valid =
                        Boolean(original.ROW_HASH) &&
                        (await CryptoVault.verifyRecord(
                            domain,
                            TamperDetectionService.buildSignedFields(domain, original),
                            original.ROW_HASH,
                        ));
                } catch {
                    valid = false; // a row the signer cannot canonicalise is unverifiable
                }
                if (!valid) {
                    tampered++;
                    logger.security("TAMPER_DETECTED", {
                        table: entry.table,
                        pk: String(original[entry.pk]),
                        action: "RESTORE_ORIGINAL_HASH_INVALID",
                    });
                    return { [entry.pk]: newPk, ROW_HASH: null };
                }
                const signingRow = { ...row, [entry.pk]: newPk };
                const stored = canonical.get(String(newPk));
                for (const c of tsCols) if (stored) signingRow[c] = stored[c];
                const rowHash = await CryptoVault.signRecord(
                    domain,
                    TamperDetectionService.buildSignedFields(domain, signingRow),
                );
                return { [entry.pk]: newPk, ROW_HASH: rowHash };
            }),
        );
        return { signRows, tampered };
    }

    /**
     * Builds the exact confirm phrase an operator must retype before a
     * restore proceeds — `RESTORE <GROUP_LIST> <rowCount> ROWS`. Mirrors
     * `DataPurgeService.buildConfirmPhrase`'s shape (same UX, same
     * mechanics) with the verb swapped for restore. This is a deliberate
     * design choice that keeps the FE Stepper's
     * "type this to confirm" UX identical across purge and restore.
     *
     * @param {string[]} groups
     * @param {number} totalRows
     * @returns {string}
     *
     * @example
     * DataRestoreService.buildConfirmPhrase(["SERVER_"], 4213); // "RESTORE SERVER_ 4213 ROWS"
     */
    static buildConfirmPhrase(groups, totalRows) {
        const groupList = [...new Set(groups)].sort().join(", ");
        return `RESTORE ${groupList} ${totalRows} ROWS`;
    }

    // ─── Archive parsing + signature verification ───────

    /**
     * Unzips the archive, recomputes the SHA-256 of `manifest.json` + every
     * `data/<TABLE>.jsonl` file present, and verifies the archive's HMAC
     * digest over that recomputed file→hash map. Nothing in the returned
     * `manifest`/`dataByTable` is trusted for a DECISION anywhere else in
     * this file until this method has returned successfully.
     *
     * @param {Buffer} zipBuffer
     * @returns {Promise<{ manifest: object, signatureDoc: object, dataByTable: Record<string, object[]> }>}
     * @throws {AppError} 400/422 — unreadable, incomplete, malformed, or signature-invalid archive.
     * @private
     */
    static async _verifyAndParseArchive(zipBuffer) {
        if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
            throw new AppError(
                PURGE_ERRORS.RESTORE_NO_FILE,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "file",
                            issue: "No archive file was uploaded.",
                        },
                    ],
                },
            );
        }

        let zip;
        try {
            zip = await JSZip.loadAsync(zipBuffer);
        } catch (err) {
            logger.warning(
                dataPurgeMessages.RESTORE_SIGNATURE_REJECTED(
                    `unreadable zip: ${err?.message ?? err}`,
                ),
            );
            throw new AppError(
                PURGE_ERRORS.RESTORE_ARCHIVE_UNREADABLE,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "ValidationError",
                },
            );
        }

        const manifestEntry = zip.file("manifest.json");
        const signatureEntry = zip.file("signature.json");
        if (!manifestEntry || !signatureEntry) {
            throw new AppError(
                PURGE_ERRORS.RESTORE_ARCHIVE_INCOMPLETE,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "ValidationError",
                },
            );
        }

        const manifestBuffer = Buffer.from(
            await manifestEntry.async("nodebuffer"),
        );
        const signatureBuffer = Buffer.from(
            await signatureEntry.async("nodebuffer"),
        );

        let manifest;
        let signatureDoc;
        try {
            manifest = JSON.parse(manifestBuffer.toString("utf8"));
        } catch {
            throw new AppError(
                PURGE_ERRORS.RESTORE_ARCHIVE_MALFORMED,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "ValidationError",
                    details: [
                        { field: "manifest.json", issue: "Not valid JSON." },
                    ],
                },
            );
        }
        try {
            signatureDoc = JSON.parse(signatureBuffer.toString("utf8"));
        } catch {
            throw new AppError(
                PURGE_ERRORS.RESTORE_ARCHIVE_MALFORMED,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "ValidationError",
                    details: [
                        { field: "signature.json", issue: "Not valid JSON." },
                    ],
                },
            );
        }

        // Every data/*.jsonl entry actually present in the zip.
        const dataFileNames = Object.keys(zip.files).filter(
            (name) =>
                name.startsWith("data/") &&
                name.endsWith(".jsonl") &&
                !zip.files[name].dir,
        );
        const dataBuffers = {};
        for (const name of dataFileNames) {
            // Sequential zip entry extraction, archives are small.
            dataBuffers[name] = Buffer.from(
                await zip.file(name).async("nodebuffer"),
            );
        }

        // Recompute SHA-256 per file over EXACTLY what BackupArchiveService
        // hashed (manifest.json + every data/*.jsonl — never
        // readable/backup-summary.xlsx, which was never part of the signed set).
        const filesToHash = { "manifest.json": manifestBuffer, ...dataBuffers };
        const recomputedHashes = {};
        for (const [name, buf] of Object.entries(filesToHash)) {
            recomputedHashes[name] = crypto
                .createHash("sha256")
                .update(buf)
                .digest("hex");
        }

        const declaredFiles =
            signatureDoc &&
            typeof signatureDoc.files === "object" &&
            signatureDoc.files !== null
                ? signatureDoc.files
                : {};
        const declaredNames = Object.keys(declaredFiles).sort();
        const recomputedNames = Object.keys(recomputedHashes).sort();
        const setMismatch =
            declaredNames.length !== recomputedNames.length ||
            declaredNames.some((n, i) => n !== recomputedNames[i]);
        const mismatchedFiles = recomputedNames.filter(
            (name) => declaredFiles[name] !== recomputedHashes[name],
        );

        // The HMAC digest is the ultimate authority — it covers the sorted
        // file->hash map (which is how manifest.json's own content,
        // including `kind` and `scope.tables`, is committed), so any edit to
        // those fields, to the digest, or to any data file is caught here.
        let digestOk = false;
        try {
            digestOk =
                !setMismatch &&
                mismatchedFiles.length === 0 &&
                (await CryptoVault.verifyRecord(
                    "APP_BACKUP_ARCHIVE",
                    recomputedHashes,
                    signatureDoc?.digest,
                ));
        } catch {
            digestOk = false;
        }

        if (!digestOk) {
            logger.warning(
                dataPurgeMessages.RESTORE_SIGNATURE_REJECTED(
                    setMismatch
                        ? "archive file set does not match signature.json"
                        : `${mismatchedFiles.length} file(s) do not match their declared hash, or the digest itself is invalid`,
                ),
            );
            throw new AppError(
                PURGE_ERRORS.RESTORE_SIGNATURE_INVALID,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "IntegrityError",
                    details: [
                        ...mismatchedFiles.map((f) => ({
                            field: "archive",
                            issue: `"${f}" content does not match the archive signature.`,
                        })),
                        ...(setMismatch
                            ? [
                                  {
                                      field: "archive",
                                      issue: "Archive file set does not match the signature manifest.",
                                  },
                              ]
                            : []),
                    ],
                },
            );
        }

        // Parse JSONL rows per table — only reached once the archive is
        // proven authentic.
        const dataByTable = {};
        for (const [name, buf] of Object.entries(dataBuffers)) {
            const table = name.slice(
                "data/".length,
                name.length - ".jsonl".length,
            );
            const text = buf.toString("utf8");
            const rows = text
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line));
            dataByTable[table] = rows;
        }

        return { manifest, signatureDoc, dataByTable };
    }

    // ─── Pre-flight ───────────────────────────────────

    /**
     * Read-only pre-flight shared by `preview()` and `restore()`. Only ever
     * called AFTER `_verifyAndParseArchive` has proven the archive authentic
     * — `manifest.kind` / `manifest.scope.tables` / `manifest.entity` are
     * trusted here because the whole manifest is inside the verified HMAC.
     *
     * @param {{ manifest: object, dataByTable: Record<string, object[]> }} params
     * @returns {Promise<{
     *   tables: string[], kind: "FULL_SCOPE"|"ENTITY", entity: object|null,
     *   rowCounts: Record<string, number>, tablesGettingNewPks: string[],
     *   fidelityNotes: string[],
     *   archiveMeta: object,
     * }>}
     * @throws {AppError} 400/403/409/422 — see the individual checks below.
     * @private
     */
    static async _preflight({ manifest, dataByTable }) {
        // ── schemaVersion ────────────────────────────────────────────────
        if (manifest?.schemaVersion !== BackupArchiveService.SCHEMA_VERSION) {
            throw new AppError(
                PURGE_ERRORS.RESTORE_SCHEMA_MISMATCH,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "manifest.schemaVersion",
                            issue: `Expected "${BackupArchiveService.SCHEMA_VERSION}", got "${manifest?.schemaVersion}".`,
                        },
                    ],
                },
            );
        }

        // ── INCREMENTAL rejection ───────────────────
        // An INCREMENTAL archive is a server-side storage optimisation and
        // never leaves the server in that form. An operator who uploads one
        // directly (instead of downloading the materialised version from the
        // Backup tab) gets a clear rejection rather than a silent partial
        // restore of only the tables that happened to be INCLUDED.
        if (manifest?.mode === "INCREMENTAL") {
            const { dataBackupMessages } = require("../constants/messages");
            logger.warning(
                dataBackupMessages.RESTORE_INCREMENTAL_REJECTED(
                    manifest?.archiveId ?? "unknown",
                ),
            );
            throw new AppError(
                PURGE_ERRORS.RESTORE_INCREMENTAL_UPLOAD,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "manifest.mode",
                            issue: "This archive is an incremental backup (mode: INCREMENTAL). Download the self-contained version from the Backup tab instead.",
                        },
                    ],
                },
            );
        }

        // ── Table allow-list — CWE-89: an uploaded archive is UNTRUSTED
        // INPUT. Every name is checked against the registry allow-list and
        // the NEVER_PURGE deny-list before anything else looks at it.
        const requestedTables = Array.isArray(manifest?.scope?.tables)
            ? manifest.scope.tables
            : [];
        if (requestedTables.length === 0) {
            throw new AppError(
                PURGE_ERRORS.RESTORE_EMPTY_SCOPE,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                },
            );
        }

        const protectedNames = requestedTables.filter((t) =>
            NEVER_PURGE.includes(t),
        );
        if (protectedNames.length > 0) {
            logger.alert(
                dataPurgeMessages.RESTORE_MALICIOUS_MANIFEST(protectedNames),
            );
            throw new AppError(
                PURGE_ERRORS.PROTECTED_TABLE,
                HTTP_STATUS.FORBIDDEN,
                {
                    type: "AuthorizationError",
                    details: protectedNames.map((t) => ({
                        field: "tables",
                        issue: `"${t}" is protected and can never be restored.`,
                    })),
                },
            );
        }

        const unknownNames = requestedTables.filter((t) => !getEntry(t));
        if (unknownNames.length > 0) {
            logger.alert(
                dataPurgeMessages.RESTORE_MALICIOUS_MANIFEST(unknownNames),
            );
            throw new AppError(
                PURGE_ERRORS.RESTORE_UNKNOWN_TABLE,
                HTTP_STATUS.FORBIDDEN,
                {
                    type: "AuthorizationError",
                    details: unknownNames.map((t) => ({
                        field: "tables",
                        issue: `"${t}" is not a recognised table.`,
                    })),
                },
            );
        }

        // A data/*.jsonl file present in the zip but not declared in
        // manifest.scope.tables is rejected too — defense in depth on top of
        // the signature check (an undeclared extra file would already have
        // failed signature verification unless the whole set was re-signed).
        const undeclaredDataTables = Object.keys(dataByTable).filter(
            (t) => !requestedTables.includes(t),
        );
        if (undeclaredDataTables.length > 0) {
            logger.alert(
                dataPurgeMessages.RESTORE_MALICIOUS_MANIFEST(
                    undeclaredDataTables,
                ),
            );
            throw new AppError(
                PURGE_ERRORS.RESTORE_UNKNOWN_TABLE,
                HTTP_STATUS.FORBIDDEN,
                {
                    type: "AuthorizationError",
                    details: undeclaredDataTables.map((t) => ({
                        field: "tables",
                        issue: `"${t}" has archived data but is not declared in the manifest scope.`,
                    })),
                },
            );
        }

        // ── kind rule ───────────────────────────────────────
        const kind = manifest.kind;
        if (kind !== "FULL_SCOPE" && kind !== "ENTITY") {
            throw new AppError(
                PURGE_ERRORS.RESTORE_INVALID_KIND,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "manifest.kind",
                            issue: `Expected "FULL_SCOPE" or "ENTITY", got "${kind}".`,
                        },
                    ],
                },
            );
        }

        if (kind === "FULL_SCOPE") {
            const liveCounts = await DataPurgeModel.countRows(requestedTables);
            const nonEmpty = requestedTables
                .filter((t) => (liveCounts[t] ?? 0) > 0)
                .map((t) => ({ table: t, liveCount: liveCounts[t] }));
            if (nonEmpty.length > 0) {
                throw new AppError(
                    PURGE_ERRORS.RESTORE_TARGET_NOT_EMPTY,
                    HTTP_STATUS.CONFLICT,
                    {
                        type: "ConflictError",
                        details: nonEmpty.map((n) => ({
                            field: n.table,
                            issue: `"${n.table}" already has ${n.liveCount} row(s).`,
                        })),
                    },
                );
            }
        } else {
            // ENTITY
            const entity = manifest.entity;
            if (
                !entity ||
                typeof entity !== "object" ||
                !entity.table ||
                !entity.keyColumn ||
                entity.keyValue === undefined ||
                entity.keyValue === null
            ) {
                throw new AppError(
                    PURGE_ERRORS.RESTORE_ENTITY_METADATA_MISSING,
                    HTTP_STATUS.UNPROCESSABLE,
                    {
                        type: "ValidationError",
                    },
                );
            }
            const parentEntry = getEntry(entity.table);
            if (!parentEntry || !requestedTables.includes(entity.table)) {
                throw new AppError(
                    PURGE_ERRORS.RESTORE_UNKNOWN_TABLE,
                    HTTP_STATUS.FORBIDDEN,
                    {
                        type: "AuthorizationError",
                        details: [
                            {
                                field: "entity.table",
                                issue: `"${entity.table}" is not a recognised, in-scope table.`,
                            },
                        ],
                    },
                );
            }
            // The key column is NEVER trusted verbatim from the archive — it
            // must equal the table's own registered primary key, or an
            // attacker-crafted manifest could probe/target an arbitrary
            // column via the ENTITY existence check (CWE-89 defense).
            if (entity.keyColumn !== parentEntry.pk) {
                throw new AppError(
                    PURGE_ERRORS.RESTORE_ENTITY_KEY_INVALID,
                    HTTP_STATUS.UNPROCESSABLE,
                    {
                        type: "ValidationError",
                        details: [
                            {
                                field: "entity.keyColumn",
                                issue: `Must be "${parentEntry.pk}" for table "${entity.table}".`,
                            },
                        ],
                    },
                );
            }
            const exists = await DataPurgeModel.existsByKey(
                entity.table,
                entity.keyColumn,
                entity.keyValue,
            );
            if (exists) {
                throw new AppError(
                    PURGE_ERRORS.RESTORE_ENTITY_KEY_PRESENT,
                    HTTP_STATUS.CONFLICT,
                    {
                        type: "ConflictError",
                        details: [
                            {
                                field: entity.keyColumn,
                                issue: `A row with ${entity.keyColumn} = ${entity.keyValue} already exists in "${entity.table}".`,
                            },
                        ],
                    },
                );
            }
        }

        // ── Fidelity report — shared with the purge preview so the two
        // never drift.
        const fidelityNotes =
            DataPurgeService.buildFidelityNotes(requestedTables);
        const tablesGettingNewPks = requestedTables.filter(
            (t) => getEntry(t).isIdentity,
        );
        const rowCounts = Object.fromEntries(
            requestedTables.map((t) => [t, (dataByTable[t] ?? []).length]),
        );

        return {
            tables: requestedTables,
            kind,
            entity: manifest.entity ?? null,
            rowCounts,
            tablesGettingNewPks,
            fidelityNotes,
            archiveMeta: {
                createdBy: manifest.createdBy ?? null,
                createdAt: manifest.createdAt ?? null,
                requestId: manifest.requestId ?? null,
                appVersion: manifest.appVersion ?? null,
                scopeHash: manifest.scopeHash ?? null,
            },
        };
    }

    // ─── Private post-commit helper ─────────────────────────────────────────

    /**
     * Writes the post-commit `T_AUDIT_LOGS` row (mirrors
     * `DataPurgeService._writePostCommitAudit`). Runs fire-and-forget from
     * `restore()` — never allowed to undo or delay the already-committed
     * restore's response.
     *
     * @param {object} opts
     * @returns {Promise<void>}
     * @private
     */
    static async _writePostCommitAudit({
        adminId,
        manifest,
        preflight,
        perTable,
        totalInserted,
        durationMs,
        clientIp,
        requestId,
    }) {
        await AuditLogModel.insert({
            REQUEST_ID: requestId ?? `restore-${Date.now()}`,
            USER_ID: Number.isFinite(Number(adminId))
                ? Number(adminId)
                : null,
            USERNAME: String(adminId ?? ""),
            METHOD: "POST",
            ENDPOINT: "/api/v1/data-purge/restore",
            PARAMS: JSON.stringify({
                kind: preflight.kind,
                archiveScopeHash: manifest.scopeHash ?? null,
                tables: preflight.tables,
                totalInserted,
                perTable,
            }).slice(0, 2000),
            STATUS_CODE: HTTP_STATUS.OK,
            STATUS_CATEGORY: "2xx",
            RESPONSE_TIME_MS: durationMs,
            CLIENT_IP: clientIp ?? null,
            SERVER_IP: null,
        });
    }
}

module.exports = DataRestoreService;
