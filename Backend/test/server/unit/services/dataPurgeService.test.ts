/**
 * @fileoverview Unit tests for DataPurgeService: scope resolution, preview,
 * password gate and the ordered executePurge safety checks (schedule window, admin, token, scope,
 * confirm phrase, lock-out ack, count drift) and post-commit behaviour.
 * Persistence and hashing are stubbed. backup(), the schedule-window lock
 * and the post-commit alert load their collaborators through src's own lazy
 * require() so they cannot be stubbed here and are not covered.
 */
import "../../../../src/config/cacheStores";
import DataPurgeService from "../../../../src/services/DataPurgeService";
import DataPurgeModel from "../../../../src/models/data-purge.model";
import AdminModel from "../../../../src/models/admin.model";
import AuditLogModel from "../../../../src/models/audit.log.model";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";
import BackupTokenService from "../../../../src/services/BackupTokenService";
import { registry } from "../../../../src/middleware/cache";

const SERVER_SCOPE = { groups: ["SERVER_"] };
const SERVER_TABLES = ["T_SERVER_ALERT_ACK_DEV", "T_SERVER_ALERT_LOG_DEV"];

afterEach(() => {
    vi.restoreAllMocks();
});

describe("DataPurgeService.resolveScope", () => {
    it("expands a group to its tables, sorted, with a stable hash", () => {
        const a = DataPurgeService.resolveScope(SERVER_SCOPE);
        const b = DataPurgeService.resolveScope({ groups: [" SERVER_ ", "SERVER_"] });
        expect(a.tables).toEqual(SERVER_TABLES);
        expect(a.requestedGroups).toEqual(["SERVER_"]);
        expect(a.autoIncludedGroups).toEqual([]);
        expect(a.scopeHash).toBe(b.scopeHash);
        expect(a.scopeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("accepts explicit tables and marks no group as auto-included", () => {
        const s = DataPurgeService.resolveScope({ tables: ["T_AUDIT_LOGS_DEV"] });
        expect(s.tables).toEqual(["T_AUDIT_LOGS_DEV"]);
        expect(s.requestedTables).toEqual(["T_AUDIT_LOGS_DEV"]);
    });

    it("a different scope yields a different hash", () => {
        const a = DataPurgeService.resolveScope({ tables: ["T_AUDIT_LOGS_DEV"] });
        const b = DataPurgeService.resolveScope({ tables: ["T_ADMINS_DEV"] });
        expect(a.scopeHash).not.toBe(b.scopeHash);
    });

    it.each([
        ["undefined selection", undefined],
        ["empty object", {}],
        ["empty arrays", { groups: [], tables: [] }],
        ["blank strings", { groups: ["  ", ""], tables: [""] }],
        ["non-array values", { groups: "SERVER_", tables: { 0: "T_ADMINS_DEV" } }],
        ["non-string entries", { groups: [1, null, {}] }],
    ])("400 INVALID_SCOPE for %s", (_n, sel) => {
        expect(() => DataPurgeService.resolveScope(sel as never)).toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it.each([
        ["unknown group", { groups: ["NOPE_"] }],
        ["unknown table", { tables: ["T_NOPE"] }],
        ["injected table", { tables: ["T_ADMINS_DEV; DROP TABLE T_USERS_DEV"] }],
        ["prototype key", { tables: ["__proto__"] }],
        ["lowercase table", { tables: ["t_admins_dev"] }],
    ])("400 UNKNOWN_TABLE for %s listing each offender", (_n, sel) => {
        let err: any;
        try {
            DataPurgeService.resolveScope(sel);
        } catch (e) {
            err = e;
        }
        expect(err.statusCode).toBe(400);
        expect(err.details.length).toBeGreaterThan(0);
    });

    it("reports both unknown groups and unknown tables together", () => {
        let err: any;
        try {
            DataPurgeService.resolveScope({ groups: ["X_"], tables: ["T_X"] });
        } catch (e) {
            err = e;
        }
        expect(err.details.map((d: { field: string }) => d.field).sort()).toEqual(["groups", "tables"]);
    });
});

describe("DataPurgeService helpers", () => {
    it("buildConfirmPhrase sorts and de-duplicates groups", () => {
        expect(DataPurgeService.buildConfirmPhrase(["T_", "SERVER_", "T_"], 12)).toBe("DELETE SERVER_, T_ 12 ROWS");
    });

    it("buildFidelityNotes is empty for registered tables without virtual/immutable columns and skips unknown ones", () => {
        expect(DataPurgeService.buildFidelityNotes(["T_AUDIT_LOGS_DEV", "T_UNKNOWN"])).toEqual([]);
    });

    it("_scopedHighWater keeps only digit high-water marks of append-only logs in scope", () => {
        const hw = DataPurgeService._scopedHighWater(
            ["T_AUDIT_LOGS_DEV", "T_SERVER_ALERT_LOG_DEV", "T_SERVER_ALERT_ACK_DEV", "T_ADMINS_DEV"],
            {
                T_AUDIT_LOGS_DEV: "123",
                T_SERVER_ALERT_LOG_DEV: "12; DROP",
                T_SERVER_ALERT_ACK_DEV: "5",
                T_ADMINS_DEV: "9",
                T_OUT_OF_SCOPE: "1",
            },
        );
        expect(hw).toEqual({ T_AUDIT_LOGS_DEV: "123" });
        expect(DataPurgeService._scopedHighWater(["T_AUDIT_LOGS_DEV"], undefined)).toEqual({});
        expect(DataPurgeService._scopedHighWater(["T_AUDIT_LOGS_DEV"], "nope" as never)).toEqual({});
        expect(DataPurgeService._scopedHighWater(["T_AUDIT_LOGS_DEV"], { T_AUDIT_LOGS_DEV: 5 as never })).toEqual({});
    });
});

describe("DataPurgeService catalogue and preview", () => {
    it("getScopeCatalogue totals rows per group and defaults missing counts to 0", async () => {
        vi.spyOn(DataPurgeModel, "countRows").mockResolvedValue({ T_AUDIT_LOGS_DEV: 4, T_ADMINS_DEV: 1, T_SERVER_ALERT_LOG_DEV: 2 });
        const cat = await DataPurgeService.getScopeCatalogue();
        const t = cat.groups.find((g) => g.group === "T_")!;
        const s = cat.groups.find((g) => g.group === "SERVER_")!;
        expect(t.totalRows).toBe(5);
        expect(s.totalRows).toBe(2);
        expect(s.tables.find((x) => x.table === "T_SERVER_ALERT_ACK_DEV")!.rowCount).toBe(0);
        expect(s.autoIncludes).toEqual([]);
        expect(new Date(cat.generatedAt).toString()).not.toBe("Invalid Date");
    });

    it("getPreview totals counts, builds the phrase and flags nothing as auto-included", async () => {
        const count = vi.spyOn(DataPurgeModel, "countRows").mockResolvedValue({ T_SERVER_ALERT_ACK_DEV: 3, T_SERVER_ALERT_LOG_DEV: 7 });
        const p = await DataPurgeService.getPreview(SERVER_SCOPE);
        expect(count).toHaveBeenCalledWith(SERVER_TABLES);
        expect(p.totalRows).toBe(10);
        expect(p.confirmPhrase).toBe("DELETE SERVER_ 10 ROWS");
        expect(p.tables.every((t) => t.autoIncluded === false)).toBe(true);
        expect(p.fidelityNotes).toEqual([]);
    });

    it("getPreview treats a missing count as 0", async () => {
        vi.spyOn(DataPurgeModel, "countRows").mockResolvedValue({});
        const p = await DataPurgeService.getPreview({ tables: ["T_AUDIT_LOGS_DEV"] });
        expect(p.totalRows).toBe(0);
        expect(p.tables[0].rowCount).toBe(0);
    });

    it("getPreview rejects an invalid scope before counting", async () => {
        const count = vi.spyOn(DataPurgeModel, "countRows");
        await expect(DataPurgeService.getPreview({})).rejects.toMatchObject({ statusCode: 400 });
        expect(count).not.toHaveBeenCalled();
    });
});

describe("DataPurgeService password gate", () => {
    it("findAdminById delegates to the model", async () => {
        const spy = vi.spyOn(AdminModel, "findById").mockResolvedValue({ ID: 1 } as never);
        expect(await DataPurgeService.findAdminById(1)).toEqual({ ID: 1 });
        expect(spy).toHaveBeenCalledWith(1);
    });

    it("401 when the admin does not exist", async () => {
        vi.spyOn(AdminModel, "findById").mockResolvedValue(null as never);
        await expect(DataPurgeService.authorise({ adminId: 1, adminPassword: "x" })).rejects.toMatchObject({ statusCode: 401 });
    });

    it("400 when the password is missing, without verifying anything", async () => {
        vi.spyOn(AdminModel, "findById").mockResolvedValue({ ID: 1, PASSWORD: "h" } as never);
        const verify = vi.spyOn(CryptoVault, "verifyAdminPassword");
        await expect(DataPurgeService.authorise({ adminId: 1, adminPassword: "" })).rejects.toMatchObject({ statusCode: 400 });
        expect(verify).not.toHaveBeenCalled();
    });

    it("401 on a wrong password", async () => {
        vi.spyOn(AdminModel, "findById").mockResolvedValue({ ID: 1, PASSWORD: "h" } as never);
        vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: false } as never);
        await expect(DataPurgeService.authorise({ adminId: 1, adminPassword: "bad" })).rejects.toMatchObject({ statusCode: 401 });
    });

    it("verifies against the stored hash and succeeds; a supplied record skips the lookup", async () => {
        const find = vi.spyOn(AdminModel, "findById").mockResolvedValue({ ID: 1, PASSWORD: "stored" } as never);
        const verify = vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: true } as never);
        await expect(DataPurgeService.authorise({ adminId: 1, adminPassword: "ok" })).resolves.toEqual({ verified: true });
        expect(verify).toHaveBeenCalledWith("ok", "stored");
        find.mockClear();
        await DataPurgeService._assertAdminPassword(1, "ok", { ID: 1, PASSWORD: "given" } as never);
        expect(find).not.toHaveBeenCalled();
        expect(verify).toHaveBeenLastCalledWith("ok", "given");
    });
});

describe("DataPurgeService.executePurge", () => {
    const base = () => ({
        selection: SERVER_SCOPE,
        backupToken: "tok",
        adminId: 1,
        adminPassword: "pw",
        confirmPhrase: "DELETE SERVER_ 5 ROWS",
        clientIp: "10.0.0.1",
        requestId: "rq",
    });
    const payload = (over: Record<string, unknown> = {}) => ({
        valid: true as const,
        payload: { adminId: 1, rowCounts: { T_SERVER_ALERT_ACK_DEV: 2, T_SERVER_ALERT_LOG_DEV: 3 }, highWater: {}, ...over },
    });

    let purge: ReturnType<typeof vi.spyOn>;
    let audit: ReturnType<typeof vi.spyOn>;
    let flush: ReturnType<typeof vi.spyOn>;
    let consume: ReturnType<typeof vi.spyOn>;
    let count: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.spyOn(AdminModel, "findById").mockResolvedValue({ ID: 1, PASSWORD: "h" } as never);
        vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: true } as never);
        consume = vi.spyOn(BackupTokenService, "consume").mockResolvedValue(payload() as never);
        count = vi.spyOn(DataPurgeModel, "countRows").mockResolvedValue({ T_SERVER_ALERT_ACK_DEV: 2, T_SERVER_ALERT_LOG_DEV: 3 });
        purge = vi.spyOn(DataPurgeModel, "purgeTables").mockImplementation((async (_t: string[], onStep: (t: string, n: number) => void) => {
            onStep("T_SERVER_ALERT_LOG_DEV", 3);
            return { totalDeleted: 5, perTable: [{ table: "T_SERVER_ALERT_LOG_DEV", deletedCount: 3 }] };
        }) as never);
        audit = vi.spyOn(AuditLogModel, "insert").mockResolvedValue(undefined as never);
        flush = vi.spyOn(registry, "flushAll");
    });

    it("purges after every check, audits, alerts and flushes caches", async () => {
        const out = await DataPurgeService.executePurge(base());
        expect(out).toMatchObject({ totalDeleted: 5, tables: SERVER_TABLES });
        expect(out.scopeHash).toMatch(/^[0-9a-f]{64}$/);
        expect(purge).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(audit).toHaveBeenCalled());
        expect(audit.mock.calls[0][0]).toMatchObject({ REQUEST_ID: "rq", USER_ID: 1, USERNAME: "1", METHOD: "DELETE", CLIENT_IP: "10.0.0.1", STATUS_CODE: 200 });
    });

    it("an audit failure after commit do not fail the purge", async () => {
        audit.mockRejectedValue(new Error("audit down"));
        await expect(DataPurgeService.executePurge(base())).resolves.toMatchObject({ totalDeleted: 5 });
        await vi.waitFor(() => expect(audit).toHaveBeenCalled());
    });

    it("audit row copes with a non-numeric admin id, a missing request id and a missing ip", async () => {
        await DataPurgeService._writePostCommitAudit({
            adminId: "abc",
            scope: DataPurgeService.resolveScope(SERVER_SCOPE),
            perTable: [],
            totalDeleted: 0,
            durationMs: 1,
        });
        const row = audit.mock.calls[0][0] as Record<string, unknown>;
        expect(row.USER_ID).toBeNull();
        expect(String(row.REQUEST_ID)).toMatch(/^purge-\d+$/);
        expect(row.CLIENT_IP).toBeNull();
        await DataPurgeService._writePostCommitAudit({
            adminId: undefined,
            scope: DataPurgeService.resolveScope(SERVER_SCOPE),
            perTable: [],
            totalDeleted: 0,
            durationMs: 1,
        });
        expect((audit.mock.calls[1][0] as Record<string, unknown>).USERNAME).toBe("");
    });

    it("401 when the admin record is gone", async () => {
        vi.spyOn(AdminModel, "findById").mockResolvedValue(null as never);
        await expect(DataPurgeService.executePurge(base())).rejects.toMatchObject({ statusCode: 401 });
        expect(consume).not.toHaveBeenCalled();
    });

    it("401 on a wrong password and the backup token is NOT consumed", async () => {
        vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: false } as never);
        await expect(DataPurgeService.executePurge(base())).rejects.toMatchObject({ statusCode: 401 });
        expect(consume).not.toHaveBeenCalled();
    });

    it("rejects a bad scope before consuming the token", async () => {
        await expect(DataPurgeService.executePurge({ ...base(), selection: { tables: ["T_NOPE"] } })).rejects.toMatchObject({ statusCode: 400 });
        expect(consume).not.toHaveBeenCalled();
    });

    it("401 BACKUP_TOKEN_REQUIRED when no token is supplied", async () => {
        await expect(DataPurgeService.executePurge({ ...base(), backupToken: "" })).rejects.toMatchObject({ statusCode: 401 });
        expect(consume).not.toHaveBeenCalled();
    });

    it.each(["expired", "tampered", "malformed", "replayed", "something-else"])("401 for a %s token and nothing is purged", async (reason) => {
        consume.mockResolvedValue({ valid: false, reason } as never);
        await expect(DataPurgeService.executePurge(base())).rejects.toMatchObject({ statusCode: 401 });
        expect(purge).not.toHaveBeenCalled();
    });

    it("token reasons map to distinct client messages", async () => {
        const msgs = new Set<string>();
        for (const reason of ["expired", "tampered", "replayed"]) {
            consume.mockResolvedValue({ valid: false, reason } as never);
            try {
                await DataPurgeService.executePurge(base());
            } catch (e) {
                msgs.add((e as Error).message);
            }
        }
        expect(msgs.size).toBe(3);
    });

    it("401 when the token was issued to a different admin (string/number tolerant)", async () => {
        consume.mockResolvedValue(payload({ adminId: 2 }) as never);
        await expect(DataPurgeService.executePurge(base())).rejects.toMatchObject({ statusCode: 401 });
        consume.mockResolvedValue(payload({ adminId: "1" }) as never);
        await expect(DataPurgeService.executePurge(base())).resolves.toBeDefined();
    });

    it("401 when the scope is wider than the backup, listing the uncovered tables", async () => {
        consume.mockResolvedValue(payload({ rowCounts: { T_SERVER_ALERT_ACK_DEV: 2 } }) as never);
        let err: any;
        try {
            await DataPurgeService.executePurge(base());
        } catch (e) {
            err = e;
        }
        expect(err.statusCode).toBe(401);
        expect(err.details[0].field).toBe("scope");
        expect(purge).not.toHaveBeenCalled();
    });

    it("treats a token without rowCounts as covering nothing", async () => {
        consume.mockResolvedValue({ valid: true, payload: { adminId: 1 } } as never);
        await expect(DataPurgeService.executePurge(base())).rejects.toMatchObject({ statusCode: 401 });
    });

    it("400 when the confirm phrase is missing, 422 when it does not match", async () => {
        await expect(DataPurgeService.executePurge({ ...base(), confirmPhrase: "" })).rejects.toMatchObject({ statusCode: 400 });
        await expect(DataPurgeService.executePurge({ ...base(), confirmPhrase: "delete server_ 5 rows" })).rejects.toMatchObject({ statusCode: 422 });
        expect(purge).not.toHaveBeenCalled();
    });

    it("accepts the phrase with surrounding whitespace", async () => {
        await expect(DataPurgeService.executePurge({ ...base(), confirmPhrase: "  DELETE SERVER_ 5 ROWS  " })).resolves.toBeDefined();
    });

    describe("lock-out acknowledgement (scope includes T_ADMINS_DEV)", () => {
        const adminScope = () => ({
            ...base(),
            selection: { tables: ["T_ADMINS_DEV"] },
            confirmPhrase: "DELETE T_ 1 ROWS",
        });

        beforeEach(() => {
            consume.mockResolvedValue({ valid: true, payload: { adminId: 1, rowCounts: { T_ADMINS_DEV: 1 } } } as never);
            count.mockResolvedValue({ T_ADMINS_DEV: 1 });
        });

        it("400 without acknowledgeLockout === true", async () => {
            await expect(DataPurgeService.executePurge(adminScope())).rejects.toMatchObject({ statusCode: 400 });
            await expect(DataPurgeService.executePurge({ ...adminScope(), acknowledgeLockout: "true" as never })).rejects.toMatchObject({ statusCode: 400 });
            expect(purge).not.toHaveBeenCalled();
        });

        it("proceeds when acknowledged", async () => {
            await expect(DataPurgeService.executePurge({ ...adminScope(), acknowledgeLockout: true })).resolves.toBeDefined();
            expect(purge).toHaveBeenCalledTimes(1);
        });
    });

    it("409 and no delete when live counts drifted from the backup (more or fewer rows)", async () => {
        count.mockResolvedValue({ T_SERVER_ALERT_ACK_DEV: 2, T_SERVER_ALERT_LOG_DEV: 4 });
        let err: any;
        try {
            await DataPurgeService.executePurge(base());
        } catch (e) {
            err = e;
        }
        expect(err.statusCode).toBe(409);
        expect(err.details[0].field).toBe("T_SERVER_ALERT_LOG_DEV");
        count.mockResolvedValue({ T_SERVER_ALERT_ACK_DEV: 1, T_SERVER_ALERT_LOG_DEV: 3 });
        await expect(DataPurgeService.executePurge(base())).rejects.toMatchObject({ statusCode: 409 });
        expect(purge).not.toHaveBeenCalled();
    });

    it("a table missing from the live recount counts as 0", async () => {
        count.mockResolvedValue({ T_SERVER_ALERT_ACK_DEV: 2 });
        await expect(DataPurgeService.executePurge(base())).rejects.toMatchObject({ statusCode: 409 });
    });

    it("bounds append-only logs by the token's high-water mark for recount and delete", async () => {
        consume.mockResolvedValue(payload({ highWater: { T_SERVER_ALERT_LOG_DEV: "99", T_SERVER_ALERT_ACK_DEV: "5" } }) as never);
        await DataPurgeService.executePurge(base());
        expect(count).toHaveBeenCalledWith(SERVER_TABLES, { T_SERVER_ALERT_LOG_DEV: "99" });
        expect(purge.mock.calls[0][2]).toEqual({ T_SERVER_ALERT_LOG_DEV: "99" });
    });

    it("a failing delete propagates, with no audit, alert or cache flush", async () => {
        purge.mockRejectedValue(new Error("ORA-02292"));
        await expect(DataPurgeService.executePurge(base())).rejects.toThrow("ORA-02292");
        expect(audit).not.toHaveBeenCalled();
        expect(flush).not.toHaveBeenCalled();
    });

    it("handles a missing params object as a missing password", async () => {
        await expect(DataPurgeService.executePurge(undefined as never)).rejects.toMatchObject({ statusCode: 400 });
    });
});
