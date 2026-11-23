"use strict";

/**
 * Data Restore — archive round trip.
 *
 * Builds a REAL backup archive with BackupArchiveService.buildBackup (real zip,
 * real SHA-256 file map, real HMAC signature) and feeds it to
 * DataRestoreService.preview / restore. Only the database is stubbed: the
 * model's stream / count / insert calls and the restore Transaction.
 *
 * Covers what the open-items plan listed as untested:
 *   - archive verification: a flipped data byte, an edited manifest, a forged
 *     digest, a stripped data file and a non-zip upload are all refused;
 *   - pre-flight allow-list: an archive RE-SIGNED with the real key that names
 *     an unregistered table is still refused (the signature is not the only gate);
 *   - FULL_SCOPE needs empty targets;
 *   - restore: password + confirm-phrase gates, tier-ordered inserts with the
 *     archived rows, a failing insert propagates (the Transaction rolls back),
 *     and the post-commit audit row.
 */

const crypto = require("crypto");
const JSZip = require("jszip");

const DataRestoreService = (require("../../../../src/services/DataRestoreService") as typeof import("../../../../src/services/DataRestoreService")).default;
const BackupArchiveService = (require("../../../../src/services/BackupArchiveService") as typeof import("../../../../src/services/BackupArchiveService")).default;
const DataPurgeService = (require("../../../../src/services/DataPurgeService") as typeof import("../../../../src/services/DataPurgeService")).default;
const DataPurgeModel = (require("../../../../src/models/data-purge.model") as typeof import("../../../../src/models/data-purge.model")).default;
const AuditLogModel = (require("../../../../src/models/audit.log.model") as typeof import("../../../../src/models/audit.log.model")).default;
const { CryptoVault } = (require("../../../../src/utils/encryption/CryptoVault") as typeof import("../../../../src/utils/encryption/CryptoVault"));
const { Transaction } = (require("../../../../src/utils/oracle-mongo-wrapper") as typeof import("../../../../src/utils/oracle-mongo-wrapper"));
const { PURGE_ERRORS } = (require("../../../../src/constants/errors") as typeof import("../../../../src/constants/errors"));

const ADMIN_ID = 7;
const ALERT_LOG = "T_SERVER_ALERT_LOG_DEV";
const ALERT_ACK = "T_SERVER_ALERT_ACK_DEV";

/** What the stubbed database holds when the backup is taken. */
const SOURCE_ROWS = {
    [ALERT_LOG]: [
        { ID: 11, ALERT_KEY: "HIGH_ERROR_RATE::global", SEVERITY: "WARNING", TRANSITION: "FIRING" },
        { ID: 12, ALERT_KEY: "HIGH_ERROR_RATE::global", SEVERITY: "WARNING", TRANSITION: "RESOLVED" },
    ],
    [ALERT_ACK]: [{ ALERT_KEY: "HIGH_ERROR_RATE::global", ACKED_BY: ADMIN_ID, NOTE: "looking" }],
};

/** Feeds SOURCE_ROWS through the model's stream callbacks (both the read-consistent and per-table paths). */
function stubSourceDatabase() {
    vi.spyOn(DataPurgeModel, "streamAllTables").mockImplementation(async (tables, { onBatch }: Record<string, any> = {}) => {
        const counts: Record<string, any> = {};
        for (const t of tables) {
            const rows = SOURCE_ROWS[t] ?? [];
            if (rows.length) await onBatch?.(t, rows.map((r) => ({ ...r })));
            counts[t] = rows.length;
        }
        return counts;
    });
    vi.spyOn(DataPurgeModel, "streamTable").mockImplementation(async (table, { onBatch }: Record<string, any> = {}) => {
        const rows = SOURCE_ROWS[table] ?? [];
        if (rows.length && onBatch) await onBatch(rows.map((r) => ({ ...r })));
        return rows.length;
    });
}

async function buildArchive() {
    stubSourceDatabase();
    const { zipBuffer } = await BackupArchiveService.buildBackup({
        selection: { tables: [ALERT_LOG, ALERT_ACK] },
        adminId: ADMIN_ID,
    });
    return zipBuffer;
}

/** Rewrites files inside a zip; `resign` recomputes signature.json with the real key (an insider forging an archive). */
async function editArchive(zipBuffer, edit, { resign = false }: Record<string, any> = {}) {
    const zip = await JSZip.loadAsync(zipBuffer);
    await edit(zip);
    if (resign) {
        const sig = JSON.parse(await zip.file("signature.json").async("string"));
        const files: Record<string, any> = {};
        for (const name of Object.keys(zip.files)) {
            if (name === "manifest.json" || (name.startsWith("data/") && !zip.files[name].dir)) {
                files[name] = crypto.createHash("sha256").update(await zip.file(name).async("nodebuffer")).digest("hex");
            }
        }
        sig.files = files;
        sig.digest = await CryptoVault.signRecord("APP_BACKUP_ARCHIVE", files);
        zip.file("signature.json", JSON.stringify(sig, null, 2));
    }
    return zip.generateAsync({ type: "nodebuffer" });
}

async function readManifest(zip) {
    return JSON.parse(await zip.file("manifest.json").async("string"));
}

const rejectsWith = (promise, message) => expect(promise).rejects.toMatchObject({ message });

describe("DataRestoreService — archive round trip", function () {
    let archive;

    beforeEach(async function () {
        vi.restoreAllMocks();
        archive = await buildArchive();
        // Restore targets are empty unless a test says otherwise.
        vi.spyOn(DataPurgeModel, "countRows").mockImplementation(async (tables) =>
            Object.fromEntries(tables.map((t) => [t, 0])),
        );
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe("preview()", function () {
        it("accepts an untouched archive and reports its tables and row counts", async function () {
            const report = await DataRestoreService.preview({ zipBuffer: archive });
            expect(report.kind).toBe("FULL_SCOPE");
            expect([...report.tables].sort()).toEqual([ALERT_ACK, ALERT_LOG].sort());
            expect(report.rowCounts).toEqual({ [ALERT_LOG]: 2, [ALERT_ACK]: 1 });
            // T_SERVER_ALERT_LOG_DEV is an identity table: its rows get new PKs.
            expect(report.tablesGettingNewPks).toContain(ALERT_LOG);
            expect(report.tablesGettingNewPks).not.toContain(ALERT_ACK);
        });

        it("refuses a flipped byte in a data file", async function () {
            const bad = await editArchive(archive, async (zip) => {
                const name = `data/${ALERT_ACK}.jsonl`;
                const text = await zip.file(name).async("string");
                zip.file(name, text.replace("looking", "lookinG"));
            });
            await rejectsWith(DataRestoreService.preview({ zipBuffer: bad }), PURGE_ERRORS.RESTORE_SIGNATURE_INVALID);
        });

        it("refuses an edited manifest", async function () {
            const bad = await editArchive(archive, async (zip) => {
                const m = await readManifest(zip);
                m.kind = "ENTITY";
                zip.file("manifest.json", JSON.stringify(m));
            });
            await rejectsWith(DataRestoreService.preview({ zipBuffer: bad }), PURGE_ERRORS.RESTORE_SIGNATURE_INVALID);
        });

        it("refuses a forged digest", async function () {
            const bad = await editArchive(archive, async (zip) => {
                const sig = JSON.parse(await zip.file("signature.json").async("string"));
                sig.digest = "0".repeat(sig.digest.length);
                zip.file("signature.json", JSON.stringify(sig));
            });
            await rejectsWith(DataRestoreService.preview({ zipBuffer: bad }), PURGE_ERRORS.RESTORE_SIGNATURE_INVALID);
        });

        it("refuses an archive with a data file stripped out", async function () {
            const bad = await editArchive(archive, async (zip) => {
                zip.remove(`data/${ALERT_LOG}.jsonl`);
            });
            await expect(DataRestoreService.preview({ zipBuffer: bad })).rejects.toBeInstanceOf(Error);
        });

        it("refuses something that is not a zip", async function () {
            await rejectsWith(
                DataRestoreService.preview({ zipBuffer: Buffer.from("not a zip at all") }),
                PURGE_ERRORS.RESTORE_ARCHIVE_UNREADABLE,
            );
        });

        it("refuses a correctly re-signed archive that names an unregistered table", async function () {
            const forged = await editArchive(
                archive,
                async (zip) => {
                    const m = await readManifest(zip);
                    m.scope.tables = [...m.scope.tables, "T_NOT_REGISTERED"];
                    zip.file("manifest.json", JSON.stringify(m));
                    zip.file("data/T_NOT_REGISTERED.jsonl", '{"ID":1}\n');
                },
                { resign: true },
            );
            await rejectsWith(DataRestoreService.preview({ zipBuffer: forged }), PURGE_ERRORS.RESTORE_UNKNOWN_TABLE);
        });

        it("refuses a FULL_SCOPE restore onto a table that still has rows", async function () {
            vi.mocked(DataPurgeModel.countRows).mockImplementation(async (tables) =>
                Object.fromEntries(tables.map((t) => [t, t === ALERT_ACK ? 3 : 0])),
            );
            await rejectsWith(DataRestoreService.preview({ zipBuffer: archive }), PURGE_ERRORS.RESTORE_TARGET_NOT_EMPTY);
        });
    });

    describe("restore()", function () {
        let inserts;
        let audit;
        let committed;

        beforeEach(function () {
            inserts = [];
            committed = false;
            vi.spyOn(DataPurgeService, "findAdminById").mockResolvedValue({ ID: ADMIN_ID, PASSWORD: "stored-hash" } as never); // partial admin row
            vi.spyOn(CryptoVault, "verifyAdminPassword").mockImplementation(async (plain) => ({ matched: plain === "right", newHash: null }));
            vi.spyOn(Transaction.prototype, "withTransaction").mockImplementation(async (fn) => {
                const result = await fn({ execute: vi.fn() } as never); // session double: no DB calls reach it
                committed = true;
                return result;
            });
            let nextId = 500;
            vi.spyOn(DataPurgeModel, "insertRestoreBatch").mockImplementation(async (table, rows) => {
                inserts.push({ table, rows });
                return { insertedCount: rows.length, returning: rows.map(() => ({ ID: nextId++ })) };
            });
            audit = vi.spyOn(AuditLogModel, "insert").mockResolvedValue({ rowsAffected: 1 });
        });

        async function phrase() {
            const report = await DataRestoreService.preview({ zipBuffer: archive });
            const groups = [...new Set(report.tables.map((t) => (t.startsWith("T_SERVER_") ? "SERVER_" : "T_")))];
            const total = Object.values(report.rowCounts).reduce((s, n) => s + n, 0);
            return DataRestoreService.buildConfirmPhrase(groups, total);
        }

        it("inserts every archived row in one transaction and audits it", async function () {
            const report = await DataRestoreService.restore({
                zipBuffer: archive,
                adminId: ADMIN_ID,
                adminPassword: "right",
                confirmPhrase: await phrase(),
            });

            expect(committed).toBe(true);
            expect(report.totalInserted).toBe(3);
            expect(report.tamperedRowsRestoredUnsigned).toBe(0);
            const byTable = Object.fromEntries(inserts.map((i) => [i.table, i.rows]));
            expect(byTable[ALERT_LOG].map((r) => r.ALERT_KEY)).toEqual(SOURCE_ROWS[ALERT_LOG].map((r) => r.ALERT_KEY));
            expect(byTable[ALERT_ACK]).toEqual([expect.objectContaining({ ALERT_KEY: "HIGH_ERROR_RATE::global", NOTE: "looking" })]);
            expect(audit).toHaveBeenCalledTimes(1);
        });

        it("refuses a wrong admin password before touching the archive data", async function () {
            await rejectsWith(
                DataRestoreService.restore({ zipBuffer: archive, adminId: ADMIN_ID, adminPassword: "wrong", confirmPhrase: await phrase() }),
                PURGE_ERRORS.INVALID_ADMIN_PASSWORD,
            );
            expect(inserts).toHaveLength(0);
        });

        it("refuses a wrong confirm phrase", async function () {
            await rejectsWith(
                DataRestoreService.restore({ zipBuffer: archive, adminId: ADMIN_ID, adminPassword: "right", confirmPhrase: "restore please" }),
                PURGE_ERRORS.CONFIRM_PHRASE_MISMATCH,
            );
            expect(inserts).toHaveLength(0);
        });

        it("propagates a failing insert so the transaction rolls back, and writes no audit row", async function () {
            vi.mocked(DataPurgeModel.insertRestoreBatch).mockRejectedValueOnce(new Error("ORA-00001: unique constraint violated"));
            await expect(
                DataRestoreService.restore({ zipBuffer: archive, adminId: ADMIN_ID, adminPassword: "right", confirmPhrase: await phrase() }),
            ).rejects.toThrow(/ORA-00001/);
            expect(committed).toBe(false);
            expect(audit).not.toHaveBeenCalled();
        });
    });
});
