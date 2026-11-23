import BackupScheduleService from "../../../../src/services/BackupScheduleService";
import BackupStoreService from "../../../../src/services/BackupStoreService";
import { logger } from "../../../../src/utils/logger";

const BSS = BackupScheduleService;
const ENV = ["DB_BACKUP_ENABLED", "DB_BACKUP_CATCHUP_WINDOW_HOURS", "DB_BACKUP_RETENTION_DAYS", "DB_BACKUP_LOCKOUT_WINDOW_MS", "DB_BACKUP_EVENT_DELAY_MS"];
const saved: Record<string, string | undefined> = {};
const DAY = 86_400_000;
const source = (due: unknown[] = [], upcoming: unknown[] = []) => ({
    getDueEvents: vi.fn().mockResolvedValue(due),
    getUpcomingEvents: vi.fn().mockResolvedValue(upcoming),
});
const arch = (archiveId: string, createdAt: string, extra: Record<string, unknown> = {}) =>
    ({ archiveId, createdAt, trigger: "SCHEDULED", eventId: 1, event: "E", chain: { baseArchiveId: "BASE", generation: 0 }, ...extra }) as never;

beforeEach(() => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    BSS._backupRunning = false;
    BSS.registerEventSource(source());
    for (const lvl of ["info", "notice", "warning", "error", "debug"] as const) vi.spyOn(logger, lvl).mockImplementation(() => undefined as never);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("registerEventSource / isEnabled", () => {
    it("rejects sources missing either method", () => {
        expect(() => BSS.registerEventSource({ getDueEvents: async () => [] } as never)).toThrow(TypeError);
        expect(() => BSS.registerEventSource(null as never)).toThrow(TypeError);
    });
    it("delegates getUpcomingEvents to the registered source", async () => {
        const src = source([], [{ eventId: 1, event: "E", at: new Date(0) }]);
        BSS.registerEventSource(src);
        expect(await BSS.getUpcomingEvents(5)).toHaveLength(1);
        expect(src.getUpcomingEvents).toHaveBeenCalledWith(5);
    });
    it("is enabled unless DB_BACKUP_ENABLED=false", () => {
        expect(BSS.isEnabled()).toBe(true);
        process.env.DB_BACKUP_ENABLED = "false";
        expect(BSS.isEnabled()).toBe(false);
    });
});

describe("triggerScheduledBackup", () => {
    it("skips when disabled, without touching the event source", async () => {
        process.env.DB_BACKUP_ENABLED = "false";
        const src = source();
        BSS.registerEventSource(src);
        expect(await BSS.triggerScheduledBackup("t")).toEqual({ skipped: "disabled", due: 0, ran: [], failed: [], pruned: [] });
        expect(src.getDueEvents).not.toHaveBeenCalled();
    });
    it("skips when another run is in flight", async () => {
        BSS._backupRunning = true;
        expect((await BSS.triggerScheduledBackup()).skipped).toBe("already-running");
    });
    it("clears the running flag even when the run throws", async () => {
        BSS.registerEventSource({ getDueEvents: vi.fn().mockRejectedValue(new Error("src down")), getUpcomingEvents: vi.fn() });
        await expect(BSS.triggerScheduledBackup()).rejects.toThrow("src down");
        expect(BSS._backupRunning).toBe(false);
    });
    it("reports nothing due and still prunes", async () => {
        vi.spyOn(BackupStoreService, "listArchives").mockResolvedValue([]);
        const res = await BSS.triggerScheduledBackup("cron");
        expect(res).toEqual({ skipped: false, due: 0, ran: [], failed: [], pruned: [] });
        expect(BSS._backupRunning).toBe(false);
    });
    it("runs due events, skips already-backed-up ones, and records failures", async () => {
        process.env.DB_BACKUP_CATCHUP_WINDOW_HOURS = "24";
        const src = source([
            { eventId: 1, event: "A", at: new Date() },
            { eventId: 2, event: "B", at: new Date() },
            { eventId: 3, event: "C", at: new Date() },
        ]);
        BSS.registerEventSource(src);
        vi.spyOn(BackupStoreService, "listArchives").mockResolvedValue([arch("x", new Date().toISOString(), { eventId: 1, event: "A" })]);
        const run = vi.spyOn(BackupStoreService, "runBackup")
            .mockResolvedValueOnce({ archiveId: "AR-B", mode: "FULL" } as never)
            .mockRejectedValueOnce(new Error("disk full"));
        const res = await BSS.triggerScheduledBackup("cron");
        expect(src.getDueEvents).toHaveBeenCalledWith(24);
        expect(res.due).toBe(3);
        expect(res.ran).toEqual([{ eventId: 2, event: "B", archiveId: "AR-B", mode: "FULL" }]);
        expect(res.failed).toEqual([{ eventId: 3, event: "C", error: "disk full" }]);
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[0][0]).toMatchObject({ trigger: "SCHEDULED", event: "B", eventId: 2 });
        expect(run.mock.calls[0][0].tables.length).toBeGreaterThan(0);
    });
    it("stringifies non-Error failures and an Error without message", async () => {
        BSS.registerEventSource(source([{ eventId: 1, event: "A", at: new Date() }]));
        vi.spyOn(BackupStoreService, "listArchives").mockResolvedValue([]);
        vi.spyOn(BackupStoreService, "runBackup").mockRejectedValue(Object.assign(new Error(""), { message: undefined }));
        const res = await BSS.triggerScheduledBackup();
        expect(res.failed[0].error).toMatch(/Error/);
    });
    it("an event only counts as backed up when trigger, id and event name all match", async () => {
        BSS.registerEventSource(source([{ eventId: 1, event: "A", at: new Date() }]));
        vi.spyOn(BackupStoreService, "listArchives").mockResolvedValue([
            arch("m", new Date().toISOString(), { trigger: "MANUAL", eventId: 1, event: "A" }),
            arch("d", new Date().toISOString(), { eventId: 1, event: "Z" }),
        ]);
        const run = vi.spyOn(BackupStoreService, "runBackup").mockResolvedValue({ archiveId: "N", mode: "FULL" } as never);
        await BSS.triggerScheduledBackup();
        expect(run).toHaveBeenCalledTimes(1);
    });
});

describe("_pruneExpiredChains", () => {
    it("deletes every member of a chain whose newest member is past retention, newest generation first", async () => {
        process.env.DB_BACKUP_RETENTION_DAYS = "10";
        const old = (d: number) => new Date(Date.now() - d * DAY).toISOString();
        vi.spyOn(BackupStoreService, "listArchives").mockResolvedValue([
            arch("g0", old(40), { chain: { baseArchiveId: "g0", generation: 0 } }),
            arch("g1", old(30), { chain: { baseArchiveId: "g0", generation: 1 } }),
            arch("fresh0", old(1), { chain: { baseArchiveId: "fresh0", generation: 0 } }),
            arch("purge", old(400), { trigger: "PURGE" }),
            arch("nochain", old(400), { chain: null }),
        ]);
        const del = vi.spyOn(BackupStoreService, "deleteArchive").mockResolvedValue({ archiveId: "", filename: "" });
        expect(await BSS._pruneExpiredChains("t")).toEqual(["g1", "g0"]);
        expect(del.mock.calls.map((c) => c[0])).toEqual(["g1", "g0"]);
    });
    it("orders members lacking a generation as 0 and keeps going when one delete fails", async () => {
        const old = new Date(Date.now() - 500 * DAY).toISOString();
        vi.spyOn(BackupStoreService, "listArchives").mockResolvedValue([
            arch("a", old, { chain: { baseArchiveId: "a" } }),
            arch("b", old, { chain: { baseArchiveId: "a", generation: 2 } }),
        ]);
        vi.spyOn(BackupStoreService, "deleteArchive").mockRejectedValueOnce(new Error("has dependents")).mockResolvedValueOnce({ archiveId: "", filename: "" });
        expect(await BSS._pruneExpiredChains("t")).toEqual(["a"]);
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });
    it("uses a 180 day default retention", async () => {
        const mk = (d: number) => new Date(Date.now() - d * DAY).toISOString();
        vi.spyOn(BackupStoreService, "listArchives").mockResolvedValue([
            arch("keep", mk(179), { chain: { baseArchiveId: "keep", generation: 0 } }),
            arch("drop", mk(181), { chain: { baseArchiveId: "drop", generation: 0 } }),
        ]);
        const del = vi.spyOn(BackupStoreService, "deleteArchive").mockResolvedValue({ archiveId: "", filename: "" });
        expect(await BSS._pruneExpiredChains("t")).toEqual(["drop"]);
        expect(del).toHaveBeenCalledTimes(1);
    });
    it("keeps a chain when its newest member is recent even if older members are expired", async () => {
        const mk = (d: number) => new Date(Date.now() - d * DAY).toISOString();
        vi.spyOn(BackupStoreService, "listArchives").mockResolvedValue([
            arch("o", mk(300), { chain: { baseArchiveId: "o", generation: 0 } }),
            arch("n", mk(1), { chain: { baseArchiveId: "o", generation: 1 } }),
        ]);
        const del = vi.spyOn(BackupStoreService, "deleteArchive");
        expect(await BSS._pruneExpiredChains("t")).toEqual([]);
        expect(del).not.toHaveBeenCalled();
    });
});

describe("lockout window", () => {
    it("getLockoutWindowMs defaults to 60s and honours the env", () => {
        expect(BSS.getLockoutWindowMs()).toBe(60_000);
        process.env.DB_BACKUP_LOCKOUT_WINDOW_MS = "5000";
        expect(BSS.getLockoutWindowMs()).toBe(5000);
    });
    it("msUntilNextScheduledBackup is null with no events or when the lookup fails", async () => {
        expect(await BSS.msUntilNextScheduledBackup()).toBeNull();
        BSS.registerEventSource({ getDueEvents: vi.fn(), getUpcomingEvents: vi.fn().mockRejectedValue(new Error("x")) });
        expect(await BSS.msUntilNextScheduledBackup()).toBeNull();
        expect(logger.warning).toHaveBeenCalledTimes(1);
        BSS.registerEventSource({ getDueEvents: vi.fn(), getUpcomingEvents: vi.fn().mockResolvedValue(null) });
        expect(await BSS.msUntilNextScheduledBackup()).toBeNull();
    });
    it("adds the event delay to the first upcoming event and requests a 26h horizon by default", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        process.env.DB_BACKUP_EVENT_DELAY_MS = "1000";
        const src = source([], [{ eventId: 1, event: "E", at: new Date("2026-01-01T00:00:10Z") }]);
        BSS.registerEventSource(src);
        expect(await BSS.msUntilNextScheduledBackup()).toBe(11_000);
        expect(src.getUpcomingEvents).toHaveBeenCalledWith(26 * 3600_000);
        await BSS.msUntilNextScheduledBackup(123);
        expect(src.getUpcomingEvents).toHaveBeenLastCalledWith(123);
    });
    it("a huge lockout window enlarges the horizon", async () => {
        process.env.DB_BACKUP_LOCKOUT_WINDOW_MS = String(30 * 3600_000);
        const src = source();
        BSS.registerEventSource(src);
        await BSS.msUntilNextScheduledBackup();
        expect(src.getUpcomingEvents).toHaveBeenCalledWith(30 * 3600_000 + 900_000);
    });
    it("getLockoutStatus: running, imminent, far away, already due, and no schedule", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        process.env.DB_BACKUP_EVENT_DELAY_MS = "1000";
        BSS._backupRunning = true;
        expect(await BSS.getLockoutStatus()).toEqual({ active: true, reason: "running", msRemaining: null, lockoutWindowMs: 60_000 });
        BSS._backupRunning = false;
        const at = (s: number) => [{ eventId: 1, event: "E", at: new Date(Date.now() + s * 1000) }];
        BSS.registerEventSource(source([], at(30)));
        expect(await BSS.getLockoutStatus()).toMatchObject({ active: true, reason: "imminent", msRemaining: 31_000 });
        BSS.registerEventSource(source([], at(3600)));
        expect(await BSS.getLockoutStatus()).toMatchObject({ active: false, reason: null, msRemaining: 3_601_000 });
        BSS.registerEventSource(source([], at(-5)));
        expect(await BSS.getLockoutStatus()).toMatchObject({ active: false, msRemaining: -4000 });
        BSS.registerEventSource(source());
        expect(await BSS.getLockoutStatus()).toMatchObject({ active: false, msRemaining: null });
    });
    it("describeLockout words each state", () => {
        expect(BSS.describeLockout({ active: false, reason: null, msRemaining: null, lockoutWindowMs: 1 })).toBeNull();
        expect(BSS.describeLockout(undefined as never)).toBeNull();
        expect(BSS.describeLockout({ active: true, reason: "running", msRemaining: null, lockoutWindowMs: 1 })).toMatch(/currently running/);
        expect(BSS.describeLockout({ active: true, reason: "imminent", msRemaining: 1500, lockoutWindowMs: 1 })).toMatch(/~2s/);
        expect(BSS.describeLockout({ active: true, reason: "imminent", msRemaining: null, lockoutWindowMs: 1 })).toMatch(/~1s/);
    });
});
