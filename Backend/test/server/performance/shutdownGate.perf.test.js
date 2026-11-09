"use strict";

/**
 * @fileoverview Shutdown gate (app.js step 3b) - PERFORMANCE.
 *
 * The gate sits on EVERY request, so two budgets:
 *   1. Not draining: handle() pass-through costs next to nothing - p95 per
 *      call < 0.05 ms over 10k calls (absolute), and the median gate loop is
 *      within a generous multiple of a bare next() loop (relative, CI-safe).
 *   2. Draining: 500 concurrent requests on the REAL app all get 503 quickly,
 *      make ZERO DB-pool calls and never reach body parsing (malformed JSON
 *      still 503, never 400). "Quickly" is RELATIVE: the
 *      drain burst's p95 must stay within DRAIN_VS_BASELINE_X of the same burst
 *      on a non-draining route that runs the whole chain to the 404 handler.
 *      Each request opens its own loopback server, so an absolute p95 measured
 *      the OS socket cost: 200 ms held on the Mac it was set on, but a slower
 *      Windows box measured 900-1 500 ms for BOTH bursts alike (2026-10-20).
 *      The ratio cancels that cost and still fails if draining does real work
 *      (a pool call, body parsing, a slow handler) — the path is cheaper than
 *      the baseline by construction. DRAIN_HANG_CEILING_MS only catches a hang.
 *
 * Pool methods are spied per test; no real Oracle connection is needed.
 */

const { ShutdownGateMiddleware } = require("../../../src/middleware/security/ShutdownGateMiddleware");
const InFlightTaskRegistry = require("../../../src/utils/InFlightTaskRegistry");

const N_CALLS = 10_000;
const PASS_P95_BUDGET_MS = 0.05;
const RELATIVE_BUDGET_X = 25; // gate loop vs bare next() loop; generous for CI jitter
const CONCURRENCY = 500;
const DRAIN_VS_BASELINE_X = 1.5;
const DRAIN_HANG_CEILING_MS = 10_000;
// Not a route: a GET runs the full non-draining chain to the 404 handler; nothing touches a pool.
const BASELINE_PATH = "/api/v1/__perf_baseline_not_found";

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

describe("shutdown gate - performance", function () {
    describe("not draining: pass-through overhead", function () {
        const gate = new ShutdownGateMiddleware({ isShuttingDown: () => false });
        const req = { method: "GET", originalUrl: "/api/v1/auth/me" };
        const res = { setHeader() {} };

        it(`p95 of handle() pass-through < ${PASS_P95_BUDGET_MS} ms over ${N_CALLS} calls`, function () {
            let nexts = 0;
            const next = () => {
                nexts++;
            };
            for (let i = 0; i < 2_000; i++) gate.handle(req, res, next); // warm JIT
            nexts = 0;

            const samples = new Float64Array(N_CALLS);
            for (let i = 0; i < N_CALLS; i++) {
                const t0 = process.hrtime.bigint();
                gate.handle(req, res, next);
                samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
            }
            const sorted = Array.from(samples).sort((a, b) => a - b);
            expect(nexts).toBe(N_CALLS); // every call passed through
            expect(pct(sorted, 0.95)).toBeLessThan(PASS_P95_BUDGET_MS);
        });

        it(`gate loop is within ${RELATIVE_BUDGET_X}x of a bare next() loop (median of 7 rounds)`, function () {
            const next = () => {};
            const bare = (r, s, n) => n();
            const time = (fn) => {
                const t0 = process.hrtime.bigint();
                for (let i = 0; i < N_CALLS; i++) fn(req, res, next);
                return Number(process.hrtime.bigint() - t0);
            };
            for (let i = 0; i < 3; i++) {
                time(bare);
                time(gate.handle);
            }
            const ratios = [];
            for (let r = 0; r < 7; r++) {
                const b = Math.max(1, time(bare));
                const g = time(gate.handle);
                ratios.push(g / b);
            }
            ratios.sort((a, b) => a - b);
            expect(ratios[3]).toBeLessThan(RELATIVE_BUDGET_X);
        });

        it("the default instance reads the real registry flag without a measurable cost (10k calls < 50 ms total)", function () {
            const { defaultShutdownGate } = require("../../../src/middleware/security/ShutdownGateMiddleware");
            const next = () => {};
            const t0 = process.hrtime.bigint();
            for (let i = 0; i < N_CALLS; i++) defaultShutdownGate.handle(req, res, next);
            const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
            expect(InFlightTaskRegistry.isShuttingDown()).toBe(false);
            expect(totalMs).toBeLessThan(50);
        });

        it("draining refusal path itself is cheap (10k refusals, p95 < 0.2 ms)", function () {
            const drainingGate = new ShutdownGateMiddleware({ isShuttingDown: () => true });
            const r = { setHeader() {} };
            let errs = 0;
            const next = (e) => {
                if (e) errs++;
            };
            for (let i = 0; i < 1_000; i++) drainingGate.handle(req, r, next);
            errs = 0;
            const samples = [];
            for (let i = 0; i < N_CALLS; i++) {
                const t0 = process.hrtime.bigint();
                drainingGate.handle(req, r, next);
                samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
            }
            samples.sort((a, b) => a - b);
            expect(errs).toBe(N_CALLS);
            expect(pct(samples, 0.95)).toBeLessThan(0.2);
        });
    });

    describe(`draining: ${CONCURRENCY} concurrent requests on the real app`, function () {
        // supertest per request = one ephemeral loopback server each (the
        // chaos-suite pattern): 500 connects to ONE listener overflow the
        // macOS accept backlog (kern.ipc.somaxconn = 128) and measure the OS.
        let app;
        let db;
        let request;

        // vi.restoreAllMocks() also drops setup.js's global AuditLogService.insertAsync
        // stub; without it the baseline burst's background audit flush reaches a pool.
        function restoreMocks() {
            vi.restoreAllMocks();
            vi.spyOn(require("../../../src/services/AuditLogService"), "insertAsync").mockResolvedValue(undefined);
        }

        beforeAll(function () {
            app = require("../../../src/app");
            db = require("../../../src/config");
            request = require("supertest");
        });
        afterEach(function () {
            restoreMocks();
        });

        async function fire(method, path, body) {
            const t0 = process.hrtime.bigint();
            let r = request(app)[method.toLowerCase()](path);
            if (body) r = r.set("Content-Type", "application/json").send(body);
            const res = await r;
            return {
                status: res.status,
                type: res.body?.error?.type,
                retryAfter: res.headers["retry-after"],
                ms: Number(process.hrtime.bigint() - t0) / 1e6,
            };
        }

        /** p95 (ms) of `n` concurrent requests built by `make(i)`; returns { results, p95 }. */
        async function burst(n, make) {
            const results = await Promise.all(Array.from({ length: n }, (_, i) => make(i)));
            const ms = results.map((r) => r.ms).sort((a, b) => a - b);
            return { results, p95: pct(ms, 0.95) };
        }

        /** Same burst shape, NOT draining, on a path that never touches a pool: the socket-cost yardstick. */
        async function baselineP95(method, body) {
            vi.spyOn(InFlightTaskRegistry, "isShuttingDown").mockReturnValue(false);
            const { results, p95 } = await burst(CONCURRENCY, () => fire(method, BASELINE_PATH, body));
            // One uniform, non-5xx answer (GET -> 404; a malformed POST is refused earlier in the chain,
            // e.g. 400/403): the yardstick must be a normal answer, never a pool failure.
            const statuses = new Set(results.map((r) => r.status));
            expect(statuses.size, `baseline statuses ${[...statuses]}`).toBe(1);
            expect([...statuses][0]).toBeLessThan(500);
            restoreMocks();
            return p95;
        }

        function spyPools() {
            return ["withConnection", "withTransaction", "withBatchConnection"].map((m) =>
                vi.spyOn(db, m).mockRejectedValue(new Error(`pool ${m} must not be touched while draining`)),
            );
        }

        it(`all ${CONCURRENCY} GETs -> 503 ServerShuttingDown, p95 within ${DRAIN_VS_BASELINE_X}x of a non-draining burst, 0 pool calls`, async function () {
            // warm the stack once
            await fire("GET", "/api/v1/auth/me");
            const before = await baselineP95("GET");

            vi.spyOn(InFlightTaskRegistry, "isShuttingDown").mockReturnValue(true);
            const pools = spyPools();
            const { results, p95 } = await burst(CONCURRENCY, (i) => fire("GET", i % 2 ? "/api/v1/billing/report" : "/api/v1/consumption/summary"));
            for (const p of pools) expect(p).not.toHaveBeenCalled();
            restoreMocks();

            // Bracket the drain burst. Each 500-socket burst runs slower than the one
            // before it on Windows (measured 2026-10-23: 1041 → 1262 → 1571 ms for the
            // SAME baseline burst), so a baseline taken only before the drain failed
            // on burst order alone. The bracket's slower side cancels that drift.
            const base = Math.max(before, await baselineP95("GET"));

            expect(new Set(results.map((r) => r.status))).toEqual(new Set([503]));
            expect(results.every((r) => r.type === "ServerShuttingDown" && r.retryAfter === "5")).toBe(true);
            expect(p95, `drain p95 ${p95.toFixed(1)} ms vs baseline ${base.toFixed(1)} ms`).toBeLessThan(Math.max(1, base) * DRAIN_VS_BASELINE_X);
            expect(p95).toBeLessThan(DRAIN_HANG_CEILING_MS);
        });

        it(`all ${CONCURRENCY} POSTs with malformed JSON -> 503 (never 400: body parsing never ran), 0 pool calls`, async function () {
            const before = await baselineP95("POST", '{"userId": "x", ');

            vi.spyOn(InFlightTaskRegistry, "isShuttingDown").mockReturnValue(true);
            const pools = spyPools();
            const { results, p95 } = await burst(CONCURRENCY, () => fire("POST", "/api/v1/auth/login", '{"userId": "x", '));
            const poolCalls = pools.map((p) => p.mock.calls.length);
            restoreMocks();

            // Same bracket as the GET test: burst-over-burst drift on slow Windows
            // boxes (measured 1239 -> 2048 ms, 2026-10-29) failed on order alone.
            const base = Math.max(before, await baselineP95("POST", '{"userId": "x", '));

            expect(results.filter((r) => r.status === 400)).toHaveLength(0);
            expect(results.filter((r) => r.type === "ParseError")).toHaveLength(0);
            expect(new Set(results.map((r) => r.status))).toEqual(new Set([503]));
            expect(p95, `drain p95 ${p95.toFixed(1)} ms vs baseline ${base.toFixed(1)} ms`).toBeLessThan(Math.max(1, base) * DRAIN_VS_BASELINE_X);
            expect(p95).toBeLessThan(DRAIN_HANG_CEILING_MS);
            expect(poolCalls).toEqual([0, 0, 0]);
        });

        it("/health/ready under the same burst answers 503 draining with 0 pool probes", async function () {
            vi.spyOn(InFlightTaskRegistry, "isShuttingDown").mockReturnValue(true);
            const pools = spyPools();
            const results = await Promise.all(
                Array.from({ length: 100 }, () => fire("GET", "/api/v1/health/ready")),
            );
            expect(new Set(results.map((r) => r.status))).toEqual(new Set([503]));
            expect(results.every((r) => r.type === "ServerShuttingDown")).toBe(true);
            for (const p of pools) expect(p).not.toHaveBeenCalled();
        });
    });
});
