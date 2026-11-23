"use strict";

/**
 * @fileoverview DataPurgeModel: registry allow-list, bounded counts, paged
 * streaming SQL (identifier / canonical-timestamp / CLOB handling), read-only
 * snapshot fallback, ordered delete, restore-batch column filtering and the
 * PK-only existence lookup. Database access is faked.
 */

import DataPurgeModel from "../../../../src/models/data-purge.model";
import db from "../../../../src/config";
import { logger } from "../../../../src/utils/logger";
import { fake } from "../../helpers/modelsWrapperFake";

vi.mock("../../../../src/utils/oracle-mongo-wrapper", async () => (await import("../../helpers/modelsWrapperFake")).wrapperMock);
vi.mock("../../../../src/config", () => ({ default: { withConnection: vi.fn() } }));
vi.mock("../../../../src/constants/purgeTables", async (importActual) => {
    const actual = await importActual<typeof import("../../../../src/constants/purgeTables")>();
    const synthetic = {
        table: "T_SYNTH", group: "T", pool: "appDbBulk", pk: "ID", isIdentity: true, appendOnlyLog: false,
        virtualColumns: ["VCOL"], fkEdges: [], deleteOrderTier: 1, restoreOrderTier: 1, rowHashDomain: null,
        identifierColumns: ["ID", "OWNER_ID"], canonicalTimestampColumns: ["TS"],
    };
    return {
        ...actual,
        getEntry: (name: string) => (name === "T_SYNTH" ? synthetic : actual.getEntry(name)),
    };
});

const LOG = "T_SERVER_ALERT_LOG_DEV"; // append-only, identity PK ID
const ACK = "T_SERVER_ALERT_ACK_DEV"; // natural PK ALERT_KEY, not identity
const DEFAULT_COLS = [
    { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER" },
    { COLUMN_NAME: "NAME", DATA_TYPE: "VARCHAR2" },
];

describe("DataPurgeModel", function () {
    afterEach(function () {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        fake.withTransaction.mockReset();
        fake.withReadOnlyTransaction.mockReset();
    });

    describe("countRows", function () {
        it("counts each registered table, bounding only append-only logs by high-water mark", async function () {
            fake.countDocuments.mockImplementation(async () => 4);
            const counts = await DataPurgeModel.countRows([LOG, ACK], { [LOG]: "99", [ACK]: "zzz" });
            expect(counts).toEqual({ [LOG]: 4, [ACK]: 4 });
            const filters = fake.countDocuments.mock.calls.map((c) => c[0]);
            expect(filters).toContainEqual({ ID: { $lte: "99" } });
            expect(filters).toContainEqual({});
        });

        it("does not bound when the high-water mark is missing or empty, and tolerates no tables", async function () {
            fake.countDocuments.mockResolvedValue(1);
            await DataPurgeModel.countRows([LOG], { [LOG]: "" });
            await DataPurgeModel.countRows([LOG]);
            await DataPurgeModel.countRows([LOG], null as never);
            expect(fake.countDocuments.mock.calls.every((c) => Object.keys(c[0]).length === 0)).toBe(true);
            expect(await DataPurgeModel.countRows(undefined as never)).toEqual({});
        });

        it("rejects an unregistered table before any query (allow-list)", async function () {
            await expect(DataPurgeModel.countRows(["USERS; DROP TABLE X"])).rejects.toThrow('is not a registered purge table');
            expect(fake.countDocuments).not.toHaveBeenCalled();
        });
    });

    describe("streaming", function () {
        const conn = { execute: vi.fn() };

        beforeEach(function () {
            conn.execute.mockReset();
            vi.mocked(db.withConnection).mockImplementation((async (_pool: string, fn: (c: typeof conn) => unknown) => fn(conn)) as never);
        });

        it("streamTable pages until a short page, passing offset/limit as binds", async function () {
            conn.execute
                .mockResolvedValueOnce({ rows: DEFAULT_COLS })
                .mockResolvedValueOnce({ rows: [{ ID: "1" }, { ID: "2" }] })
                .mockResolvedValueOnce({ rows: [{ ID: "3" }] });
            const batches: unknown[][] = [];
            const total = await DataPurgeModel.streamTable(LOG, { pageSize: 2, onBatch: (r) => { batches.push(r); } });
            expect(total).toBe(3);
            expect(batches).toHaveLength(2);
            expect(db.withConnection).toHaveBeenCalledWith("appDbBulk", expect.any(Function));
            expect(conn.execute.mock.calls[0][1]).toEqual({ tableName: LOG });
            expect(conn.execute.mock.calls[1][1]).toEqual({ skip: 0, pageSize: 2 });
            expect(conn.execute.mock.calls[2][1]).toEqual({ skip: 2, pageSize: 2 });
            const sql: string = conn.execute.mock.calls[1][0];
            expect(sql).toContain('ORDER BY "ID"');
            expect(sql).toContain('TO_CHAR("ID") AS "ID"');
            expect(sql).toContain('"NAME"');
            expect(sql).not.toContain("WHERE");
        });

        it("stops on an empty page, defaults the page size and ignores a missing onBatch", async function () {
            conn.execute.mockResolvedValueOnce({ rows: DEFAULT_COLS }).mockResolvedValueOnce({ rows: undefined });
            expect(await DataPurgeModel.streamTable(LOG, { pageSize: -5 })).toBe(0);
            expect(conn.execute.mock.calls[1][1]).toEqual({ skip: 0, pageSize: 1000 });
            conn.execute.mockResolvedValueOnce({ rows: DEFAULT_COLS }).mockResolvedValueOnce({ rows: [] });
            expect(await DataPurgeModel.streamTable(LOG)).toBe(0);
        });

        it("fails loudly when USER_TAB_COLUMNS is empty or missing", async function () {
            conn.execute.mockResolvedValueOnce({ rows: [] });
            await expect(DataPurgeModel.streamTable(LOG)).rejects.toThrow("USER_TAB_COLUMNS returned no columns");
            conn.execute.mockResolvedValueOnce({});
            await expect(DataPurgeModel.streamTable(LOG)).rejects.toThrow("USER_TAB_COLUMNS returned no columns");
        });

        it("renders canonical timestamps and fetches CLOBs as strings", async function () {
            conn.execute
                .mockResolvedValueOnce({ rows: [
                    { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER" },
                    { COLUMN_NAME: "TS", DATA_TYPE: "TIMESTAMP(6)" },
                    { COLUMN_NAME: "BODY", DATA_TYPE: "CLOB" },
                ] })
                .mockResolvedValueOnce({ rows: [] });
            await DataPurgeModel.streamTable("T_SYNTH");
            const [sql, , opts] = conn.execute.mock.calls[1];
            expect(sql).toContain(`TO_CHAR("TS",'YYYY-MM-DD"T"HH24:MI:SS.FF6') AS "TS"`);
            expect(sql).toContain('"BODY"');
            expect(opts.fetchInfo).toEqual({ BODY: { type: 2001 } });
            expect(opts.outFormat).toBe(4002);
        });

        it("streamTableFiltered binds the filter value and validates the columns", async function () {
            await expect(DataPurgeModel.streamTableFiltered(LOG, { whereColumns: [], whereValue: 1 })).rejects.toThrow("non-empty opts.whereColumns");
            await expect(DataPurgeModel.streamTableFiltered(LOG, { whereColumns: undefined as never, whereValue: 1 })).rejects.toThrow("non-empty opts.whereColumns");

            conn.execute.mockResolvedValueOnce({ rows: DEFAULT_COLS });
            await expect(DataPurgeModel.streamTableFiltered(LOG, { whereColumns: ['NAME" OR 1=1 --'], whereValue: "v" })).rejects.toThrow("are not columns of");

            conn.execute.mockResolvedValueOnce({ rows: DEFAULT_COLS }).mockResolvedValueOnce({ rows: [] });
            await DataPurgeModel.streamTableFiltered(LOG, { whereColumns: ["ID", "NAME"], whereValue: "'; DROP" });
            const [sql, binds] = conn.execute.mock.calls.at(-1)!;
            expect(sql).toContain('WHERE "ID" = :whereValue OR "NAME" = :whereValue');
            expect(sql).not.toContain("DROP");
            expect(binds).toEqual({ whereValue: "'; DROP", skip: 0, pageSize: 1000 });
        });

        it("rejects unregistered tables on the per-table path", async function () {
            await expect(DataPurgeModel.streamTable("NOPE")).rejects.toThrow("streamTable");
            expect(db.withConnection).not.toHaveBeenCalled();
        });
    });

    describe("streamAllTables", function () {
        beforeEach(function () {
            vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
        });

        it("validates its input", async function () {
            await expect(DataPurgeModel.streamAllTables([])).rejects.toThrow("non-empty array");
            await expect(DataPurgeModel.streamAllTables(undefined as never)).rejects.toThrow("non-empty array");
            await expect(DataPurgeModel.streamAllTables(["NOPE"])).rejects.toThrow("streamAllTables");
            expect(fake.withReadOnlyTransaction).not.toHaveBeenCalled();
        });

        it("streams every table inside one read-only transaction and tags batches with the table", async function () {
            const session = { execute: vi.fn() };
            session.execute
                .mockResolvedValueOnce({ rows: DEFAULT_COLS }).mockResolvedValueOnce({ rows: [{ ID: 1 }] })
                .mockResolvedValueOnce({ rows: DEFAULT_COLS }).mockResolvedValueOnce({ rows: [] });
            fake.withReadOnlyTransaction.mockImplementation(async (fn: (s: unknown) => unknown) => fn(session));
            const seen: Array<[string, number]> = [];
            const out = await DataPurgeModel.streamAllTables([LOG, ACK], { pageSize: 5, onBatch: (t, rows) => { seen.push([t, rows.length]); } });
            expect(out).toEqual({ [LOG]: 1, [ACK]: 0 });
            expect(seen).toEqual([[LOG, 1]]);
            expect(fake.txCtor.at(-1)).toEqual([fake.db]);
        });

        it("defaults page size / callback when options are invalid", async function () {
            const session = { execute: vi.fn().mockResolvedValueOnce({ rows: DEFAULT_COLS }).mockResolvedValueOnce({ rows: [{ ID: 1 }] }) };
            fake.withReadOnlyTransaction.mockImplementation(async (fn: (s: unknown) => unknown) => fn(session));
            await DataPurgeModel.streamAllTables([LOG], { pageSize: 1.5, onBatch: "x" as never });
            expect(session.execute.mock.calls[1][1]).toEqual({ skip: 0, pageSize: 1000 });
        });

        it.each([
            ["errorNum on originalError", Object.assign(new Error("wrapped"), { originalError: { errorNum: 1555, message: "ORA-01555 snap" } })],
            ["ORA-01555 in the message", new Error("ORA-01555: snapshot too old")],
        ])("converts a snapshot-too-old failure (%s) into a typed error", async function (_n, failure) {
            fake.withReadOnlyTransaction.mockRejectedValue(failure);
            await expect(DataPurgeModel.streamAllTables([LOG, ACK])).rejects.toMatchObject({
                code: "ORA_01555_SNAPSHOT_TOO_OLD",
                isSnapshotTooOld: true,
                originalError: failure,
            });
            expect(logger.warning).toHaveBeenCalledTimes(1);
        });

        it("rethrows other failures untouched, even a bare non-Error", async function () {
            const boom = new Error("ORA-03113");
            fake.withReadOnlyTransaction.mockRejectedValueOnce(boom);
            await expect(DataPurgeModel.streamAllTables([LOG])).rejects.toBe(boom);
            fake.withReadOnlyTransaction.mockRejectedValueOnce(undefined);
            await expect(DataPurgeModel.streamAllTables([LOG])).rejects.toBeUndefined();
            expect(logger.warning).not.toHaveBeenCalled();
        });

        it("tolerates a snapshot failure that carries no message text", async function () {
            fake.withReadOnlyTransaction.mockRejectedValue({ originalError: { errorNum: 1555 } });
            await expect(DataPurgeModel.streamAllTables([LOG])).rejects.toMatchObject({ isSnapshotTooOld: true });
        });
    });

    describe("deleteTable / purgeTables", function () {
        it("deleteTable bounds append-only logs and reports deletedCount (default 0)", async function () {
            const deleteMany = vi.fn().mockResolvedValueOnce({ deletedCount: 7 }).mockResolvedValueOnce({});
            const session = { collection: vi.fn(() => ({ deleteMany })) };
            expect(await DataPurgeModel.deleteTable(LOG, session as never, "50")).toBe(7);
            expect(deleteMany).toHaveBeenLastCalledWith({ ID: { $lte: "50" } });
            expect(await DataPurgeModel.deleteTable(ACK, session as never, "50")).toBe(0);
            expect(deleteMany).toHaveBeenLastCalledWith({});
            await expect(DataPurgeModel.deleteTable("NOPE", session as never, "1")).rejects.toThrow("deleteTable");
        });

        it("purgeTables runs every delete in one transaction and reports each step", async function () {
            const deleteMany = vi.fn().mockResolvedValueOnce({ deletedCount: 2 }).mockResolvedValueOnce({ deletedCount: 3 });
            const session = { collection: vi.fn(() => ({ deleteMany })) };
            fake.withTransaction.mockImplementation(async (fn: (s: unknown) => unknown) => fn(session));
            const steps: Array<[string, number]> = [];
            const res = await DataPurgeModel.purgeTables([LOG, ACK], (t, n) => steps.push([t, n]), { [LOG]: "10" });
            expect(res.totalDeleted).toBe(5);
            expect(res.perTable).toHaveLength(2);
            expect(steps).toHaveLength(2);
            expect(fake.withTransaction).toHaveBeenCalledTimes(1);
        });

        it("purgeTables works with default callback/high-water and propagates a mid-purge failure", async function () {
            const session = { collection: vi.fn(() => ({ deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }) })) };
            fake.withTransaction.mockImplementation(async (fn: (s: unknown) => unknown) => fn(session));
            expect((await DataPurgeModel.purgeTables([ACK])).totalDeleted).toBe(1);
            const failing = { collection: vi.fn(() => ({ deleteMany: vi.fn().mockRejectedValue(new Error("ORA-02292")) })) };
            fake.withTransaction.mockImplementation(async (fn: (s: unknown) => unknown) => fn(failing));
            await expect(DataPurgeModel.purgeTables([ACK], undefined, null as never)).rejects.toThrow("ORA-02292");
        });
    });

    describe("insertRestoreBatch", function () {
        function makeSession(columns: unknown, insertResult: unknown = { insertedCount: 2, returning: [{ ID: 5 }] }) {
            const insertMany = vi.fn().mockResolvedValue(insertResult);
            const session = {
                execute: vi.fn().mockResolvedValue({ rows: columns }),
                collection: vi.fn(() => ({ insertMany })),
            };
            return { session, insertMany };
        }

        it("short-circuits an empty or non-array batch without querying", async function () {
            const { session } = makeSession(DEFAULT_COLS);
            expect(await DataPurgeModel.insertRestoreBatch(LOG, [], session as never)).toEqual({ insertedCount: 0, returning: [] });
            expect(await DataPurgeModel.insertRestoreBatch(LOG, null as never, session as never)).toEqual({ insertedCount: 0, returning: [] });
            expect(session.execute).not.toHaveBeenCalled();
            await expect(DataPurgeModel.insertRestoreBatch("NOPE", [{}], session as never)).rejects.toThrow("insertRestoreBatch");
        });

        it("fails when the live table has no columns", async function () {
            await expect(DataPurgeModel.insertRestoreBatch(LOG, [{ ID: 1 }], makeSession([]).session as never)).rejects.toThrow("USER_TAB_COLUMNS returned no columns");
            await expect(DataPurgeModel.insertRestoreBatch(LOG, [{ ID: 1 }], makeSession(undefined).session as never)).rejects.toThrow("no columns");
        });

        it("drops identity PK, virtual and unknown columns, converts types and null-fills ragged rows", async function () {
            const cols = [
                { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER" },
                { COLUMN_NAME: "OWNER_ID", DATA_TYPE: "NUMBER" },
                { COLUMN_NAME: "QTY", DATA_TYPE: "NUMBER" },
                { COLUMN_NAME: "TS", DATA_TYPE: "TIMESTAMP(6)" },
                { COLUMN_NAME: "D", DATA_TYPE: "DATE" },
                { COLUMN_NAME: "NAME", DATA_TYPE: "VARCHAR2" },
                { COLUMN_NAME: "VCOL", DATA_TYPE: "NUMBER" },
            ];
            const { session, insertMany } = makeSession(cols);
            const rows = [
                { ID: 1, OWNER_ID: "9007199254740993", QTY: "5", TS: "2026-01-01T00:00:00.000000", D: 0, NAME: "a", VCOL: 1, GONE: "x" },
                { ID: 2, QTY: 6, NAME: null },
                { QTY: undefined, NAME: "z" },
            ];
            const res = await DataPurgeModel.insertRestoreBatch("T_SYNTH", rows, session as never);
            expect(res).toEqual({ insertedCount: 2, returning: [{ ID: 5 }] });
            const [inserted, opts] = insertMany.mock.calls[0];
            expect(opts).toEqual({ returning: ["ID"] });
            expect(inserted[0]).toEqual({ OWNER_ID: "9007199254740993", QTY: 5, TS: new Date("2026-01-01T00:00:00.000000"), D: new Date(0), NAME: "a" });
            expect(inserted[1]).toEqual({ OWNER_ID: null, QTY: 6, TS: null, D: null, NAME: null });
            expect(inserted[2]).toEqual({ OWNER_ID: null, QTY: null, TS: null, D: null, NAME: "z" });
            for (const r of inserted) expect(Object.keys(r).sort()).toEqual(Object.keys(inserted[0]).sort());
            expect(session.execute.mock.calls[0][1]).toEqual({ tableName: "T_SYNTH" });
        });

        it("keeps a natural (non-identity) PK, requests no RETURNING, and defaults missing result fields", async function () {
            const { session, insertMany } = makeSession([{ COLUMN_NAME: "ALERT_KEY", DATA_TYPE: "VARCHAR2" }], {});
            const res = await DataPurgeModel.insertRestoreBatch(ACK, [{ ALERT_KEY: "k" }], session as never);
            expect(res).toEqual({ insertedCount: 0, returning: [] });
            expect(insertMany).toHaveBeenCalledWith([{ ALERT_KEY: "k" }], { returning: [] });
        });
    });

    describe("existsByKey", function () {
        it("looks up only by the registered primary key", async function () {
            fake.findOne.mockResolvedValueOnce({ ID: 1 }).mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
            expect(await DataPurgeModel.existsByKey(LOG, "ID", 1)).toBe(true);
            expect(fake.findOne).toHaveBeenCalledWith({ ID: 1 });
            expect(await DataPurgeModel.existsByKey(LOG, "ID", 2)).toBe(false);
            expect(await DataPurgeModel.existsByKey(LOG, "ID", 3)).toBe(false);
        });

        it("refuses arbitrary columns and unregistered tables", async function () {
            await expect(DataPurgeModel.existsByKey(LOG, "ALERT_KEY", "x")).rejects.toThrow("refusing an arbitrary column lookup");
            await expect(DataPurgeModel.existsByKey("NOPE", "ID", 1)).rejects.toThrow("existsByKey");
            expect(fake.findOne).not.toHaveBeenCalled();
        });
    });
});
