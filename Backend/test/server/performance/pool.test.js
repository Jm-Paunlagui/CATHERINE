"use strict";

const config = require("../../../src/config");
const { connections } = require("../../../src/config/database");

/**
 * Pool performance tests.
 *
 * Each test registers a unique temporary connection name in database.js
 * so it gets a fresh, uncached pool from the module-level poolRegistry
 * inside oracle.js. oracledb.createPool is stubbed to return fake pools.
 *
 * _createPool validates every new pool by calling pool.getConnection() →
 * conn.ping() → conn.close() before returning. This "validation conn"
 * is _allConns[0]; the conn used by the actual test is _allConns[1+].
 */
describe("DB Pool Performance", function () {
    let poolCounter = 0;

    function testPoolName() {
        return `perf_test_${++poolCounter}_${Date.now()}`;
    }

    function fakeConn(delayMs = 0) {
        return {
            execute: vi.fn().mockImplementation(async () => {
                if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
                return { rows: [{ RESULT: 1 }] };
            }),
            ping: vi.fn().mockResolvedValue(),
            commit: vi.fn().mockResolvedValue(),
            rollback: vi.fn().mockResolvedValue(),
            close: vi.fn().mockResolvedValue(),
        };
    }

    function fakePool(opts = {}) {
        const allConns = [];
        const pool = {
            poolMin: opts.poolMin ?? 2,
            poolMax: opts.poolMax ?? 5,
            connectionsOpen: 0,
            connectionsInUse: 0,
            queueLength: 0,
            getConnection: vi.fn().mockImplementation(async () => {
                const c = fakeConn(opts.connDelay ?? 0);
                pool.connectionsOpen++;
                pool.connectionsInUse++;
                const origClose = c.close;
                c.close = vi.fn().mockImplementation(async () => {
                    pool.connectionsInUse--;
                    return origClose();
                });
                allConns.push(c);
                return c;
            }),
            close: vi.fn().mockResolvedValue(),
            _allConns: allConns,
        };
        return pool;
    }

    let createPoolStub;
    let currentPoolName;

    beforeEach(function () {
        createPoolStub = vi.spyOn(config.oracledb, "createPool");
        currentPoolName = testPoolName();
        connections[currentPoolName] = {
            user: "test_user",
            password: "test_pass",
            connectString: "localhost:1521/testdb",
        };
    });

    afterEach(function () {
        if (currentPoolName) delete connections[currentPoolName];
        vi.restoreAllMocks();
    });

    // ── Tests ──────────────────────────────────────────────────────────────

    it("withConnection acquires and releases within a reasonable time", async function () {
        const pool = fakePool();
        createPoolStub.mockResolvedValue(pool);

        const start = process.hrtime.bigint();
        const result = await config.withConnection(
            currentPoolName,
            async (conn) => {
                return conn.execute("SELECT 1 FROM DUAL");
            },
        );
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

        expect(result).toEqual({ rows: [{ RESULT: 1 }] });
        expect(elapsed).toBeLessThan(500);
        // _allConns[0] = validation conn, [1] = user conn
        const userConn = pool._allConns[1];
        expect(userConn.close).toHaveBeenCalledTimes(1);
    });

    it("withConnection handles concurrent acquisitions correctly", async function () {
        const pool = fakePool({ connDelay: 5 });
        createPoolStub.mockResolvedValue(pool);

        const CONCURRENT = 10;
        const start = process.hrtime.bigint();
        const results = await Promise.all(
            Array.from({ length: CONCURRENT }, (_, i) =>
                config.withConnection(currentPoolName, async (conn) => {
                    return conn.execute(`SELECT ${i} FROM DUAL`);
                }),
            ),
        );
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

        expect(results).toHaveLength(CONCURRENT);
        results.forEach((r) => expect(r.rows).toHaveLength(1));
        // 1 validation conn + 10 user conns = 11 total
        const userConns = pool._allConns.slice(1);
        expect(userConns).toHaveLength(CONCURRENT);
        userConns.forEach((c) => expect(c.close).toHaveBeenCalledTimes(1));
        expect(elapsed).toBeLessThan(3000);
    });

    it("withBatchConnection runs multiple ops on a single connection", async function () {
        const pool = fakePool();
        createPoolStub.mockResolvedValue(pool);

        const operations = [
            async (conn) => conn.execute("SELECT 1 FROM DUAL"),
            async (conn) => conn.execute("SELECT 2 FROM DUAL"),
            async (conn) => conn.execute("SELECT 3 FROM DUAL"),
        ];

        const results = await config.withBatchConnection(
            currentPoolName,
            operations,
        );

        expect(results).toHaveLength(3);
        results.forEach((r, i) => {
            expect(r.success).toBe(true);
            expect(r.index).toBe(i);
        });
        // 1 validation + 1 batch = 2 total; batch shares one connection
        expect(pool.getConnection.mock.calls.length).toBe(2);
    });

    it("withTransaction commits on success", async function () {
        const pool = fakePool();
        createPoolStub.mockResolvedValue(pool);

        const result = await config.withTransaction(
            currentPoolName,
            async (conn) => {
                await conn.execute("INSERT INTO T VALUES (1)");
                return "committed";
            },
        );

        expect(result).toBe("committed");
        const txnConn = pool._allConns[1];
        expect(txnConn.commit).toHaveBeenCalledTimes(1);
        expect(txnConn.rollback).not.toHaveBeenCalled();
    });

    it("withTransaction rolls back on failure", async function () {
        const pool = fakePool();
        createPoolStub.mockResolvedValue(pool);

        try {
            await config.withTransaction(currentPoolName, async () => {
                throw new Error("deliberate failure");
            });
            expect.fail("should have thrown");
        } catch (err) {
            expect(err.message).toContain("deliberate failure");
        }

        const txnConn = pool._allConns[1];
        expect(txnConn.rollback).toHaveBeenCalledTimes(1);
        expect(txnConn.commit).not.toHaveBeenCalled();
    });

    it("getPoolStats returns pool metrics after a connection is used", async function () {
        const pool = fakePool({ poolMin: 5, poolMax: 20 });
        createPoolStub.mockResolvedValue(pool);

        await config.withConnection(currentPoolName, async (conn) => {
            return conn.execute("SELECT 1 FROM DUAL");
        });

        const stats = await config.getPoolStats();
        expect(stats).toHaveProperty("timestamp");
        expect(stats["timestamp"]).toEqual(expect.any(String));
        expect(stats).toHaveProperty("healthMetrics");
        expect(stats).toHaveProperty("pools");
        expect(stats.pools[currentPoolName]).toHaveProperty("poolMin");
        expect(stats.pools[currentPoolName]).toHaveProperty("poolMax");
        expect(stats.pools[currentPoolName]).toHaveProperty("connectionsOpen");
    });
});
