"use strict";

/**
 * @fileoverview Reliability of AuditLogService's batched persistence: size and
 * interval triggers, single-flight, requeue-at-front after a DB failure,
 * bounded queue (oldest dropped), non-tight retry loop and the capped,
 * non-requeueing shutdown flush. DB and timers are faked.
 */

import AuditLogService from "../../../src/services/AuditLogService";
import AuditLogModel from "../../../src/models/audit.log.model";
import { logger } from "../../../src/utils/logger";

type Rec = import("../../../src/models/audit.log.model").AuditRecord;
const rec = (n: number) => ({ REQUEST_ID: `r${n}` }) as unknown as Rec;
const ids = (rows: Rec[]) => rows.map((r) => (r as unknown as { REQUEST_ID: string }).REQUEST_ID);

describe("AuditLogService batched flush reliability", function () {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeAll(function () {
        // test/server/setup.ts stubs insertAsync globally; this suite needs the real one.
        (AuditLogService.insertAsync as unknown as { mockRestore?: () => void }).mockRestore?.();
    });

    beforeEach(function () {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        warn = vi.spyOn(logger, "warning").mockImplementation(async () => {});
        AuditLogService._pending = [];
        AuditLogService._flushing = null;
        AuditLogService._retryNotBefore = 0;
        if (AuditLogService._flushTimer) clearTimeout(AuditLogService._flushTimer);
        AuditLogService._flushTimer = null;
    });

    afterEach(function () {
        if (AuditLogService._flushTimer) clearTimeout(AuditLogService._flushTimer);
        AuditLogService._flushTimer = null;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("buffers a record and flushes a single row via insert() when the interval elapses", async function () {
        const insert = vi.spyOn(AuditLogModel, "insert").mockResolvedValue({} as never);
        const batch = vi.spyOn(AuditLogModel, "insertBatch").mockResolvedValue({} as never);
        await AuditLogService.insertAsync(rec(1));
        expect(insert).not.toHaveBeenCalled();
        expect(AuditLogService._flushTimer).not.toBeNull();

        await vi.advanceTimersByTimeAsync(AuditLogService.FLUSH_INTERVAL_MS);
        expect(insert).toHaveBeenCalledTimes(1);
        expect(batch).not.toHaveBeenCalled();
        expect(AuditLogService._pending).toEqual([]);
        expect(AuditLogService._flushTimer).toBeNull();
    });

    it("arms only one interval timer for many records and flushes them as one batch", async function () {
        const batch = vi.spyOn(AuditLogModel, "insertBatch").mockResolvedValue({} as never);
        await AuditLogService.insertAsync(rec(1));
        const timer = AuditLogService._flushTimer;
        await AuditLogService.insertAsync(rec(2));
        expect(AuditLogService._flushTimer).toBe(timer);

        await vi.advanceTimersByTimeAsync(AuditLogService.FLUSH_INTERVAL_MS);
        expect(batch).toHaveBeenCalledTimes(1);
        expect(ids(batch.mock.calls[0][0] as Rec[])).toEqual(["r1", "r2"]);
    });

    it("flushes immediately when the buffer reaches FLUSH_MAX", async function () {
        const batch = vi.spyOn(AuditLogModel, "insertBatch").mockResolvedValue({} as never);
        for (let i = 0; i < AuditLogService.FLUSH_MAX - 1; i++) await AuditLogService.insertAsync(rec(i));
        expect(batch).not.toHaveBeenCalled();
        await AuditLogService.insertAsync(rec(99));
        expect(batch).toHaveBeenCalledTimes(1);
        expect((batch.mock.calls[0][0] as Rec[]).length).toBe(AuditLogService.FLUSH_MAX);
    });

    it("does not start a second flush while one is running (single flight) and joins it", async function () {
        let release!: () => void;
        const batch = vi.spyOn(AuditLogModel, "insertBatch").mockImplementation(
            () => new Promise<never>((resolve) => { release = () => resolve({} as never); }),
        );
        AuditLogService._pending = [rec(1), rec(2)];
        const first = AuditLogService.flushPending();
        const second = AuditLogService.flushPending();
        expect(batch).toHaveBeenCalledTimes(1);
        let secondDone = false;
        void second.then(() => { secondDone = true; });
        await Promise.resolve();
        expect(secondDone).toBe(false); // joined the running flush, not a new one
        release();
        await first;
        await second;
        expect(AuditLogService._flushing).toBeNull();
    });

    it("on failure requeues the batch AHEAD of rows that arrived meanwhile and retries on the next tick, not in a loop", async function () {
        let fail = true;
        const batch = vi.spyOn(AuditLogModel, "insertBatch").mockImplementation((async (rows: Rec[]) => {
            if (fail) {
                AuditLogService._pending.push(rec(100)); // arrives during the failing insert
                throw new Error("ORA-03113");
            }
            return { rows: ids(rows) };
        }) as never);

        AuditLogService._pending = [rec(1), rec(2)];
        await AuditLogService.flushPending();
        expect(batch).toHaveBeenCalledTimes(1);
        expect(ids(AuditLogService._pending)).toEqual(["r1", "r2", "r100"]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(AuditLogService._flushTimer).not.toBeNull(); // retry armed

        // A size-triggered flush during the back-off window must NOT retry immediately.
        for (let i = 0; i < AuditLogService.FLUSH_MAX; i++) await AuditLogService.insertAsync(rec(200 + i));
        expect(batch).toHaveBeenCalledTimes(1);

        fail = false;
        await vi.advanceTimersByTimeAsync(AuditLogService.FLUSH_INTERVAL_MS);
        expect(batch).toHaveBeenCalledTimes(2);
        expect(ids(batch.mock.calls[1][0] as Rec[]).slice(0, 3)).toEqual(["r1", "r2", "r100"]);
        expect(AuditLogService._pending).toEqual([]);
        expect(AuditLogService._retryNotBefore).toBe(0);
    });

    it("caps the queue at PENDING_MAX during an outage, dropping the OLDEST rows with one warning", async function () {
        vi.spyOn(AuditLogModel, "insertBatch").mockRejectedValue(new Error("pool exhausted"));
        const max = AuditLogService.PENDING_MAX;
        AuditLogService._pending = Array.from({ length: max + 5 }, (_, i) => rec(i));
        await AuditLogService.flushPending();

        expect(AuditLogService._pending).toHaveLength(max);
        expect(ids(AuditLogService._pending)[0]).toBe("r5");
        expect(warn).toHaveBeenCalledTimes(2); // batch failed + overflow dropped
    });

    it("final flush makes one attempt and never requeues on failure", async function () {
        vi.spyOn(AuditLogModel, "insertBatch").mockRejectedValue(new Error("db down"));
        AuditLogService._pending = [rec(1), rec(2)];
        await AuditLogService.flushPending({ final: true });
        expect(AuditLogService._pending).toEqual([]);
        expect(AuditLogService._flushTimer).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("final flush gives up after FINAL_FLUSH_TIMEOUT_MS when the insert hangs", async function () {
        vi.spyOn(AuditLogModel, "insert").mockImplementation(() => new Promise<never>(() => {}));
        AuditLogService._pending = [rec(1)];
        const done = AuditLogService.flushPending({ final: true });
        await vi.advanceTimersByTimeAsync(AuditLogService.FINAL_FLUSH_TIMEOUT_MS);
        await done;
        expect(String(warn.mock.calls[0][0])).toContain("timed out");
        expect(AuditLogService._pending).toEqual([]);
    });

    it("final flush that succeeds resets the retry back-off", async function () {
        vi.spyOn(AuditLogModel, "insertBatch").mockResolvedValue({} as never);
        AuditLogService._retryNotBefore = Date.now() + 99_000;
        AuditLogService._pending = [rec(1), rec(2)];
        await AuditLogService.flushPending({ final: true });
        expect(AuditLogService._retryNotBefore).toBe(0);
    });

    it("final flush waits for a running flush, but no longer than the final-flush cap", async function () {
        vi.spyOn(AuditLogModel, "insertBatch").mockImplementation(() => new Promise<never>(() => {}));
        AuditLogService._pending = [rec(1), rec(2)];
        void AuditLogService.flushPending(); // stuck on the pool
        AuditLogService._pending = [rec(3)];

        const insert = vi.spyOn(AuditLogModel, "insert").mockResolvedValue({} as never);
        const done = AuditLogService.flushPending({ final: true });
        await vi.advanceTimersByTimeAsync(AuditLogService.FINAL_FLUSH_TIMEOUT_MS);
        await done;
        expect(insert).toHaveBeenCalledTimes(1);
    });

    it("is a no-op for an empty buffer", async function () {
        const insert = vi.spyOn(AuditLogModel, "insert");
        const batch = vi.spyOn(AuditLogModel, "insertBatch");
        await AuditLogService.flushPending();
        expect(insert).not.toHaveBeenCalled();
        expect(batch).not.toHaveBeenCalled();
        expect(AuditLogService._flushTimer).toBeNull();
    });
});
