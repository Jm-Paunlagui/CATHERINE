"use strict";

/**
 * Data Restore — FK remap and ROW_HASH re-sign.
 *
 * The template registry has no FK edges and no signed tables, so this file mocks
 * `purgeTables` with a two-table project registry:
 *
 *   T_PARENT_TEST  identity PK, restore tier 1
 *   T_CHILD_TEST   identity PK, FK PARENT_ID -> T_PARENT_TEST.ID, ROW_HASH signed
 *                  under domain "T_CHILD_TEST", restore tier 2
 *
 * A real archive is built and restored with the DB stubbed. Checks:
 *   - the parent is inserted before the child (tier order);
 *   - every child PARENT_ID is rewritten to the parent's NEW identity;
 *   - a child whose ORIGINAL hash verifies is re-signed over its NEW PK and
 *     remapped FK (never the archived values);
 *   - a child whose original hash does not verify is restored with
 *     ROW_HASH = NULL and counted, never laundered into a valid signature.
 */

vi.mock("../../../../src/constants/purgeTables", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../../../src/constants/purgeTables")>();
    const base = {
        group: real.PURGE_GROUP_KEYS.T,
        pool: real.PURGE_POOL,
        pk: "ID",
        isIdentity: true,
        virtualColumns: [],
        deleteOrderTier: 1,
        canonicalTimestampColumns: [],
        identifierColumns: ["ID"],
    };
    const PURGE_TABLES = [
        { ...base, table: "T_PARENT_TEST", fkEdges: [], deleteOrderTier: 2, restoreOrderTier: 1, rowHashDomain: null },
        {
            ...base,
            table: "T_CHILD_TEST",
            fkEdges: [{ column: "PARENT_ID", refTable: "T_PARENT_TEST", refColumn: "ID" }],
            deleteOrderTier: 1,
            restoreOrderTier: 2,
            rowHashDomain: "T_CHILD_TEST",
            identifierColumns: ["ID", "PARENT_ID"],
        },
    ];
    const byName = new Map(PURGE_TABLES.map((e) => [e.table, e]));
    const getEntry = (t) => byName.get(t) ?? null;
    const order = (key) => (names) => {
        const set = names ? new Set(names) : null;
        return PURGE_TABLES.filter((e) => !set || set.has(e.table)).sort((a, b) => a[key] - b[key]);
    };
    return {
        ...real,
        PURGE_TABLES,
        getEntry,
        requireEntry: (t) => {
            const e = getEntry(t);
            if (!e) throw new Error(`not registered: ${t}`);
            return e;
        },
        getTablesByGroup: (g) => PURGE_TABLES.filter((e) => e.group === g),
        getAllTableNames: () => PURGE_TABLES.map((e) => e.table),
        getDeleteOrder: order("deleteOrderTier"),
        getRestoreOrder: order("restoreOrderTier"),
    };
});

// Loaded with import() (in beforeAll), not require(): vi.mock above only applies to
// modules resolved through Vitest's module graph.
let DataRestoreService: typeof import("../../../../src/services/DataRestoreService").default;
let BackupArchiveService: typeof import("../../../../src/services/BackupArchiveService").default;
let DataPurgeService: typeof import("../../../../src/services/DataPurgeService").default;
let DataPurgeModel: typeof import("../../../../src/models/data-purge.model").default;
let AuditLogModel: typeof import("../../../../src/models/audit.log.model").default;
let TamperDetectionService: typeof import("../../../../src/services/TamperDetectionService").default;
let CryptoVault: typeof import("../../../../src/utils/encryption/CryptoVault").CryptoVault;
let Transaction: typeof import("../../../../src/utils/oracle-mongo-wrapper").Transaction;

async function loadModules() {
    DataRestoreService = (await import("../../../../src/services/DataRestoreService")).default;
    BackupArchiveService = (await import("../../../../src/services/BackupArchiveService")).default;
    DataPurgeService = (await import("../../../../src/services/DataPurgeService")).default;
    DataPurgeModel = (await import("../../../../src/models/data-purge.model")).default;
    AuditLogModel = (await import("../../../../src/models/audit.log.model")).default;
    TamperDetectionService = (await import("../../../../src/services/TamperDetectionService")).default;
    ({ CryptoVault } = await import("../../../../src/utils/encryption/CryptoVault"));
    ({ Transaction } = await import("../../../../src/utils/oracle-mongo-wrapper"));
}

const PARENT = "T_PARENT_TEST";
const CHILD = "T_CHILD_TEST";
const DOMAIN = "T_CHILD_TEST";

const SOURCE_ROWS = {
    [PARENT]: [
        { ID: 1, NAME: "alpha" },
        { ID: 2, NAME: "beta" },
    ],
    [CHILD]: [
        { ID: 10, PARENT_ID: 1, LABEL: "a-1", ROW_HASH: "valid:10:1" },
        { ID: 11, PARENT_ID: 2, LABEL: "b-1", ROW_HASH: "valid:11:2" },
        { ID: 12, PARENT_ID: 2, LABEL: "b-2", ROW_HASH: "forged" },
    ],
};

/** Parent rows get identities 101, 102…; child rows 201, 202…, in insert order. */
const NEW_ID_BASE = { [PARENT]: 100, [CHILD]: 200 };

describe("DataRestoreService — FK remap and ROW_HASH re-sign", function () {
    let inserts;
    let rehashes;
    let report;

    beforeAll(async function () {
        await loadModules();
        inserts = [];
        rehashes = [];

        vi.spyOn(DataPurgeModel, "streamAllTables").mockImplementation(async (tables, { onBatch } = {}) => {
            for (const t of tables) await onBatch?.(t, SOURCE_ROWS[t].map((r) => ({ ...r })));
            return Object.fromEntries(tables.map((t) => [t, SOURCE_ROWS[t].length]));
        });
        vi.spyOn(DataPurgeModel, "streamTable").mockImplementation(async (t, { onBatch } = {}) => {
            if (onBatch) await onBatch(SOURCE_ROWS[t].map((r) => ({ ...r })));
            return SOURCE_ROWS[t].length;
        });
        vi.spyOn(DataPurgeModel, "countRows").mockImplementation(async (tables) =>
            Object.fromEntries(tables.map((t) => [t, 0])),
        );

        // The child's signed fields are its PK, FK and label; the archive keeps the real HMAC.
        vi.spyOn(TamperDetectionService, "buildSignedFields").mockImplementation((domain, row) => ({
            ID: String(row.ID),
            PARENT_ID: String(row.PARENT_ID),
            LABEL: String(row.LABEL),
        }));
        const realVerify = CryptoVault.verifyRecord.bind(CryptoVault);
        const realSign = CryptoVault.signRecord.bind(CryptoVault);
        vi.spyOn(CryptoVault, "verifyRecord").mockImplementation(async (domain, fields, sig) =>
            domain === DOMAIN ? sig === `valid:${fields.ID}:${fields.PARENT_ID}` : realVerify(domain, fields, sig),
        );
        vi.spyOn(CryptoVault, "signRecord").mockImplementation(async (domain, fields) =>
            domain === DOMAIN ? `resigned:${fields.ID}:${fields.PARENT_ID}` : realSign(domain, fields),
        );

        const { zipBuffer } = await BackupArchiveService.buildBackup({ selection: { tables: [PARENT, CHILD] }, adminId: 1 });

        vi.spyOn(DataPurgeService, "findAdminById").mockResolvedValue({ ID: 1, PASSWORD: "h" } as never); // partial admin row
        vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: true, newHash: null });
        vi.spyOn(AuditLogModel, "insert").mockResolvedValue({ rowsAffected: 1 });
        const counters = { ...NEW_ID_BASE };
        vi.spyOn(DataPurgeModel, "insertRestoreBatch").mockImplementation(async (table, rows) => {
            inserts.push({ table, rows: rows.map((r) => ({ ...r })) });
            return { insertedCount: rows.length, returning: rows.map(() => ({ ID: ++counters[table] })) };
        });
        const session = {
            execute: vi.fn(),
            collection: (table) => ({
                bulkUpdateByKeys: async (rows) => {
                    rehashes.push(...rows.map((r) => ({ table, ...r })));
                    return { acknowledged: true, modifiedCount: rows.length };
                },
            }),
        };
        vi.spyOn(Transaction.prototype, "withTransaction").mockImplementation(async (fn) => fn(session as never)); // session double: execute + collection only

        report = await DataRestoreService.restore({
            zipBuffer,
            adminId: 1,
            adminPassword: "pw",
            confirmPhrase: DataRestoreService.buildConfirmPhrase(["T_"], 5),
        });
    });

    afterAll(function () {
        vi.restoreAllMocks();
    });

    it("inserts the parent tier before the child tier", function () {
        expect(inserts.map((i) => i.table)).toEqual([PARENT, CHILD]);
    });

    it("rewrites every child FK to the parent's new identity", function () {
        const child = inserts.find((i) => i.table === CHILD).rows;
        // archived parent 1 -> 101, parent 2 -> 102
        expect(child.map((r) => [r.LABEL, Number(r.PARENT_ID)])).toEqual([
            ["a-1", 101],
            ["b-1", 102],
            ["b-2", 102],
        ]);
    });

    it("re-signs a verified child over its NEW pk and remapped FK", function () {
        const byPk = Object.fromEntries(rehashes.map((r) => [r.ID, r.ROW_HASH]));
        expect(byPk[201]).toBe("resigned:201:101");
        expect(byPk[202]).toBe("resigned:202:102");
    });

    it("restores a child with a forged original hash UNSIGNED and counts it", function () {
        const forged = rehashes.find((r) => r.ID === 203);
        expect(forged.ROW_HASH).toBeNull();
        expect(report.tamperedRowsRestoredUnsigned).toBe(1);
        expect(report.totalResigned).toBe(2);
        expect(report.totalInserted).toBe(5);
    });
});
