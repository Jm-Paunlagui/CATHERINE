"use strict";

/**
 * @fileoverview Chaos: the audit-log write path against a flapping database.
 * A seeded PRNG decides which batch inserts fail; the invariants are that no
 * accepted row is lost while capacity allows, order is preserved, no row is
 * persisted twice, and the queue never exceeds PENDING_MAX.
 */

import AuditLogService from "../../../src/services/AuditLogService";
import AuditLogModel from "../../../src/models/audit.log.model";
import { logger } from "../../../src/utils/logger";

type Rec = import("../../../src/models/audit.log.model").AuditRecord;
const rec = (n: number) => ({ REQUEST_ID: `r${n}` }) as unknown as Rec;
const idOf = (r: Rec) => Number((r as unknown as { REQUEST_ID: string }).REQUEST_ID.slice(1));

/** mulberry32 — deterministic PRNG. */
function prng(seed: number) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("AuditLogService under a flapping database (chaos)", function () {
    beforeAll(function () {
        (AuditLogService.insertAsync as unknown as { mockRestore?: () => void }).mockRestore?.();
    });

    beforeEach(function () {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        vi.spyOn(logger, "warning").mockImplementation(async () => {});
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

    it("loses no rows, duplicates none and keeps order when 50% of inserts fail", async function () {
        const rand = prng(1234);
        const persisted: number[] = [];
        const accept = async (rows: Rec[]) => {
            if (rand() < 0.5) throw new Error("ORA-12170 connect timeout");
            persisted.push(...rows.map(idOf));
            return {};
        };
        vi.spyOn(AuditLogModel, "insert").mockImplementation(((r: Rec) => accept([r])) as never);
        vi.spyOn(AuditLogModel, "insertBatch").mockImplementation(accept as never);

        const total = 300;
        for (let i = 0; i < total; i++) {
            await AuditLogService.insertAsync(rec(i));
            if (i % 7 === 0) await vi.advanceTimersByTimeAsync(400);
            expect(AuditLogService._pending.length).toBeLessThanOrEqual(AuditLogService.PENDING_MAX);
        }
        // DB heals: drain with timer ticks until the queue is empty.
        vi.spyOn(AuditLogModel, "insertBatch").mockImplementation((async (rows: Rec[]) => {
            persisted.push(...rows.map(idOf));
            return {};
        }) as never);
        vi.spyOn(AuditLogModel, "insert").mockImplementation((async (r: Rec) => {
            persisted.push(idOf(r));
            return {};
        }) as never);
        for (let guard = 0; guard < 50 && AuditLogService._pending.length > 0; guard++) {
            await vi.advanceTimersByTimeAsync(AuditLogService.FLUSH_INTERVAL_MS);
        }
        await AuditLogService.flushPending();

        expect(new Set(persisted).size).toBe(persisted.length); // no duplicates
        expect(persisted).toHaveLength(total); // no loss
        expect([...persisted].sort((a, b) => a - b)).toEqual(Array.from({ length: total }, (_, i) => i));
    });

    it("a total outage longer than PENDING_MAX drops only the oldest rows and recovers afterwards", async function () {
        vi.spyOn(AuditLogModel, "insertBatch").mockRejectedValue(new Error("pool exhausted"));
        vi.spyOn(AuditLogModel, "insert").mockRejectedValue(new Error("pool exhausted"));
        const total = AuditLogService.PENDING_MAX + 150;
        for (let i = 0; i < total; i++) {
            await AuditLogService.insertAsync(rec(i));
            if (i % 40 === 0) await vi.advanceTimersByTimeAsync(AuditLogService.FLUSH_INTERVAL_MS);
        }
        await vi.advanceTimersByTimeAsync(AuditLogService.FLUSH_INTERVAL_MS);
        await AuditLogService.flushPending();
        expect(AuditLogService._pending.length).toBeLessThanOrEqual(AuditLogService.PENDING_MAX);
        const kept = AuditLogService._pending.map(idOf);
        expect(kept[kept.length - 1]).toBe(total - 1); // newest survives
        expect(kept).toEqual([...kept].sort((a, b) => a - b)); // order preserved

        const persisted: number[] = [];
        vi.spyOn(AuditLogModel, "insertBatch").mockImplementation((async (rows: Rec[]) => {
            persisted.push(...rows.map(idOf));
            return {};
        }) as never);
        AuditLogService._retryNotBefore = 0;
        await AuditLogService.flushPending();
        expect(persisted).toEqual(kept);
        expect(AuditLogService._pending).toEqual([]);
    });

    it("shutdown during an outage returns promptly and does not leave a retry timer armed", async function () {
        vi.spyOn(AuditLogModel, "insertBatch").mockImplementation(() => new Promise<never>(() => {}));
        for (let i = 0; i < 5; i++) await AuditLogService.insertAsync(rec(i));
        const done = AuditLogService.flushPending({ final: true });
        await vi.advanceTimersByTimeAsync(AuditLogService.FINAL_FLUSH_TIMEOUT_MS);
        await done;
        expect(AuditLogService._flushTimer).toBeNull();
        expect(AuditLogService._pending).toEqual([]);
    });
});
