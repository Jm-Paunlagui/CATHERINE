"use strict";

/**
 * @fileoverview Unit tests for BatchGuard — segregation of succeeded / failed
 * / pending outcomes, FATAL_SESSION batch-abort behaviour, per-item retry
 * hooks, and the httpStatusFor() 200/207/null mapping.
 */

const { BatchGuard } = require("../../../../src/utils/resilience/BatchGuard");
const {
    RetryPolicy,
} = require("../../../../src/utils/resilience/RetryPolicy");
const { logger } = require("../../../../src/utils/logger");
const { requestContext } = require("../../../../src/utils/requestContext");

function oraError(code) {
    return new Error(`ORA-${String(code).padStart(5, "0")}: simulated`);
}

function makePolicy(overrides = {}) {
    return new RetryPolicy({
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        classifier: RetryPolicy.classifyDbError,
        label: "batch-guard-test",
        ...overrides,
    });
}

describe("BatchGuard", function () {
    describe("constructor validation", function () {
        it("throws TypeError when retryPolicy is missing", function () {
            expect(() => new BatchGuard({})).toThrow(TypeError);
        });

        it("throws TypeError when retryPolicy has no execute() method", function () {
            expect(() => new BatchGuard({ retryPolicy: {} })).toThrow(
                TypeError,
            );
        });

        it("accepts a valid RetryPolicy instance", function () {
            expect(
                () => new BatchGuard({ retryPolicy: makePolicy() }),
            ).not.toThrow();
        });

        it("clamps concurrency to at least 1", function () {
            expect(
                () =>
                    new BatchGuard({
                        retryPolicy: makePolicy(),
                        concurrency: 0,
                    }),
            ).not.toThrow();
        });
    });

    describe("run() — segregation", function () {
        it("returns empty buckets for an empty item list", async function () {
            const guard = new BatchGuard({
                retryPolicy: makePolicy(),
                concurrency: 4,
            });

            const report = await guard.run([], async () => "unused");

            expect(report).toEqual({ succeeded: [], failed: [], pending: [] });
        });

        it("all items succeed → succeeded only, in input order", async function () {
            const guard = new BatchGuard({
                retryPolicy: makePolicy(),
                concurrency: 4,
            });
            const items = [1, 2, 3, 4];

            const report = await guard.run(items, async (item) => item * 10);

            expect(report.succeeded).toEqual([
                { item: 1, result: 10 },
                { item: 2, result: 20 },
                { item: 3, result: 30 },
                { item: 4, result: 40 },
            ]);
            expect(report.failed).toHaveLength(0);
            expect(report.pending).toHaveLength(0);
        });

        it("segregates a mix of success and a PERMANENT_DB failure", async function () {
            const guard = new BatchGuard({
                retryPolicy: makePolicy(),
                concurrency: 4,
            });
            const items = [1, 2, 3];

            const report = await guard.run(items, async (item) => {
                if (item === 2) throw oraError(904); // PERMANENT_DB — no retry
                return item;
            });

            expect(report.succeeded.map((s) => s.item).sort()).toEqual([
                1, 3,
            ]);
            expect(report.failed).toHaveLength(1);
            expect(report.failed[0]).toMatchObject({
                item: 2,
                attempts: 1,
                classification: "PERMANENT_DB",
            });
            expect(report.pending).toHaveLength(0);
        });

        it("retries a TRANSIENT_DB failure and eventually succeeds without appearing in failed[]", async function () {
            const guard = new BatchGuard({
                retryPolicy: makePolicy({ maxAttempts: 3 }),
                concurrency: 2,
            });
            let calls = 0;

            const report = await guard.run([1], async () => {
                calls += 1;
                if (calls < 2) throw oraError(3113);
                return "ok";
            });

            expect(report.succeeded).toEqual([{ item: 1, result: "ok" }]);
            expect(report.failed).toHaveLength(0);
            expect(calls).toBe(2);
        });
    });

    describe("run() — FATAL_SESSION abort", function () {
        it("aborts un-started items into pending after a FATAL_SESSION exhaustion", async function () {
            // concurrency: 1 → strictly sequential processing, so item order
            // (and which items are "un-started" at abort time) is deterministic.
            const guard = new BatchGuard({
                retryPolicy: makePolicy({ maxAttempts: 10 }), // FATAL_SESSION still caps at 2 regardless of maxAttempts
                concurrency: 1,
                label: "fatal-batch",
            });
            const items = [1, 2, 3, 4, 5];

            const report = await guard.run(items, async (item) => {
                if (item === 2) throw oraError(28); // FATAL_SESSION
                return item;
            });

            expect(report.succeeded).toEqual([{ item: 1, result: 1 }]);
            expect(report.failed).toHaveLength(1);
            expect(report.failed[0]).toMatchObject({
                item: 2,
                attempts: 2,
                classification: "FATAL_SESSION",
            });
            // Items 3, 4, 5 never started — moved to pending, in order.
            expect(report.pending.map((p) => p.item)).toEqual([3, 4, 5]);
            expect(report.pending[0].reason).toContain("ORA-00028");
        });

        it("does not abort the batch for classifications other than FATAL_SESSION", async function () {
            const guard = new BatchGuard({
                retryPolicy: makePolicy(),
                concurrency: 1,
            });
            const items = [1, 2, 3];

            const report = await guard.run(items, async (item) => {
                if (item === 2) throw oraError(904); // PERMANENT_DB — not an abort trigger
                return item;
            });

            expect(report.succeeded.map((s) => s.item)).toEqual([1, 3]);
            expect(report.failed.map((f) => f.item)).toEqual([2]);
            expect(report.pending).toHaveLength(0);
        });
    });

    describe("run() — per-item retry hooks", function () {
        it("forwards a per-item hooks() factory to retryPolicy.execute for idempotency probing", async function () {
            const guard = new BatchGuard({ retryPolicy: makePolicy() });
            const probe = vi.fn(async () => ({ resolved: "probed-value" }));

            const report = await guard.run(
                ["row-a"],
                async () => {
                    throw oraError(3113);
                },
                { hooks: () => ({ onRetry: probe }) },
            );

            expect(report.succeeded).toEqual([
                { item: "row-a", result: "probed-value" },
            ]);
            expect(probe).toHaveBeenCalledTimes(1);
        });

        it("applies a static hooks object identically to every item", async function () {
            const guard = new BatchGuard({ retryPolicy: makePolicy() });
            const probe = vi.fn(async () => ({ resolved: "same-for-all" }));

            const report = await guard.run(
                ["a", "b"],
                async () => {
                    throw oraError(3113);
                },
                { hooks: { onRetry: probe } },
            );

            expect(report.succeeded.map((s) => s.result)).toEqual([
                "same-for-all",
                "same-for-all",
            ]);
            expect(probe).toHaveBeenCalledTimes(2);
        });
    });

    describe("httpStatusFor()", function () {
        it("returns 200 when everything succeeded", function () {
            expect(
                BatchGuard.httpStatusFor({
                    succeeded: [1],
                    failed: [],
                    pending: [],
                }),
            ).toBe(200);
        });

        it("returns 207 when some items failed", function () {
            expect(
                BatchGuard.httpStatusFor({
                    succeeded: [1],
                    failed: [1],
                    pending: [],
                }),
            ).toBe(207);
        });

        it("returns 207 when some items are pending", function () {
            expect(
                BatchGuard.httpStatusFor({
                    succeeded: [1],
                    failed: [],
                    pending: [1],
                }),
            ).toBe(207);
        });

        it("returns null when nothing succeeded (total failure)", function () {
            expect(
                BatchGuard.httpStatusFor({
                    succeeded: [],
                    failed: [1],
                    pending: [],
                }),
            ).toBe(null);
            expect(
                BatchGuard.httpStatusFor({
                    succeeded: [],
                    failed: [],
                    pending: [],
                }),
            ).toBe(null);
        });
    });

    // ─── observability trace (BATCH_START/BATCH_DONE) ────────────────────────

    describe("run() — observability logging", function () {
        let debugSpy;
        let infoSpy;

        beforeEach(function () {
            debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
            infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
        });

        afterEach(function () {
            vi.restoreAllMocks();
        });

        it("logs BATCH_START (debug) with total + concurrency at entry", async function () {
            const guard = new BatchGuard({
                retryPolicy: makePolicy(),
                concurrency: 4,
                label: "obs-batch",
            });

            await guard.run([1, 2, 3], async (item) => item);

            const startCall = debugSpy.mock.calls.find(([msg]) => msg.includes("Batch starting"));
            expect(startCall).toBeDefined();
            const [, startMeta] = startCall;
            expect(startMeta).toMatchObject({ label: "obs-batch", total: 3, concurrency: 4 });
        });

        it("BATCH_DONE (info) carries correct succeeded/failed/pending counts for a mixed outcome", async function () {
            const guard = new BatchGuard({
                retryPolicy: makePolicy({ maxAttempts: 10 }), // FATAL_SESSION caps at 2 regardless
                concurrency: 1,
                label: "obs-batch-mixed",
            });
            const items = [1, 2, 3, 4, 5];

            const report = await guard.run(items, async (item) => {
                if (item === 2) throw oraError(28); // FATAL_SESSION → aborts 3,4,5 into pending
                return item;
            });

            expect(report.succeeded).toHaveLength(1);
            expect(report.failed).toHaveLength(1);
            expect(report.pending).toHaveLength(3);

            const doneCall = infoSpy.mock.calls.find(([msg]) => msg.includes("Batch done"));
            expect(doneCall).toBeDefined();
            const [doneMsg, doneMeta] = doneCall;
            expect(doneMsg).toContain("succeeded=1");
            expect(doneMsg).toContain("failed=1");
            expect(doneMsg).toContain("pending=3");
            expect(doneMeta).toMatchObject({
                label: "obs-batch-mixed",
                succeeded: 1,
                failed: 1,
                pending: 3,
            });
            expect(typeof doneMeta.ms).toBe("number");
        });

        it("BATCH_DONE (info) fires with all-zero counts for an empty item list", async function () {
            const guard = new BatchGuard({ retryPolicy: makePolicy(), label: "obs-batch-empty" });

            await guard.run([], async () => "unused");

            const doneCall = infoSpy.mock.calls.find(([msg]) => msg.includes("Batch done"));
            expect(doneCall).toBeDefined();
            const [, doneMeta] = doneCall;
            expect(doneMeta).toMatchObject({
                label: "obs-batch-empty",
                succeeded: 0,
                failed: 0,
                pending: 0,
            });
        });
    });

    // ─── requestId propagation through a batch run ────────────────────────────

    describe("run() — requestId propagation via AsyncLocalStorage", function () {
        afterEach(function () {
            vi.restoreAllMocks();
        });

        it("every logger.log call made during a batch run carries the ALS requestId", async function () {
            const observedRequestIds = [];
            vi.spyOn(logger, "log").mockImplementation(async () => {
                observedRequestIds.push(requestContext.getStore()?.requestId ?? null);
            });

            const guard = new BatchGuard({
                retryPolicy: makePolicy(),
                concurrency: 2,
                label: "requestid-batch-test",
            });

            const report = await requestContext.run({ requestId: "test-req-456" }, () =>
                guard.run([1, 2, 3], async (item) => item * 10),
            );

            expect(report.succeeded).toHaveLength(3);
            expect(observedRequestIds.length).toBeGreaterThan(0);
            expect(observedRequestIds.every((id) => id === "test-req-456")).toBe(true);
        });
    });
});
