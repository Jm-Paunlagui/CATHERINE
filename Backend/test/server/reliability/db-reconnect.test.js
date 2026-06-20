"use strict";

const config = require("../../../src/config");
const { connections } = require("../../../src/config/database");

/**
 * DB reconnection & resilience tests.
 *
 * Each test registers a unique temporary connection name so it gets an
 * uncached pool. oracledb.createPool is stubbed to control pool behaviour.
 *
 * _createPool validates new pools via getConnection → ping → close before
 * returning, so stubs must account for this validation call (call index 0).
 */
describe("DB Reconnection & Resilience", function () {
    let poolCounter = 0;

    function testPoolName() {
        return `reconn_test_${++poolCounter}_${Date.now()}`;
    }

    function fakeConn() {
        return {
            execute: vi.fn().mockResolvedValue({ rows: [{ RESULT: 1 }] }),
            ping: vi.fn().mockResolvedValue(),
            commit: vi.fn().mockResolvedValue(),
            rollback: vi.fn().mockResolvedValue(),
            close: vi.fn().mockResolvedValue(),
        };
    }

    function fakePool() {
        const allConns = [];
        const pool = {
            poolMin: 2,
            poolMax: 10,
            connectionsOpen: 0,
            connectionsInUse: 0,
            queueLength: 0,
            getConnection: vi.fn().mockImplementation(async () => {
                const c = fakeConn();
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

    // ── Error wrapping ────────────────────────────────────────────────────

    it("withConnection wraps errors with connectionName and duration metadata", async function () {
        // Pool validation (call 0) must succeed; user call (call 1) fails
        let callCount = 0;
        const pool = fakePool();
        pool.getConnection = vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) return fakeConn(); // validation
            throw new Error("ORA-12541: TNS:no listener");
        });
        createPoolStub.mockResolvedValue(pool);

        try {
            await config.withConnection(currentPoolName, async (conn) => {
                return conn.execute("SELECT 1 FROM DUAL");
            });
            expect.fail("should have thrown");
        } catch (err) {
            expect(err.message).toContain(currentPoolName);
            expect(err).toHaveProperty("connectionName", currentPoolName);
            expect(err).toHaveProperty("durationMs");
            expect(err["durationMs"]).toEqual(expect.any(Number));
            expect(err).toHaveProperty("originalError");
            expect(err.originalError.message).toContain("ORA-12541");
        }
    });

    it("withConnection releases connection even when callback throws", async function () {
        const pool = fakePool();
        createPoolStub.mockResolvedValue(pool);

        try {
            await config.withConnection(currentPoolName, async (conn) => {
                throw new Error("ORA-00942: table does not exist");
            });
        } catch {
            // expected
        }

        // _allConns[0] = validation, [1] = user conn — must be closed
        const userConn = pool._allConns[1];
        expect(userConn.close).toHaveBeenCalledTimes(1);
    });

    it("withTransaction rolls back and releases connection on callback failure", async function () {
        const pool = fakePool();
        createPoolStub.mockResolvedValue(pool);

        try {
            await config.withTransaction(currentPoolName, async (conn) => {
                await conn.execute("INSERT bad data");
                throw new Error("constraint violation");
            });
        } catch {
            // expected
        }

        const txnConn = pool._allConns[1];
        expect(txnConn.rollback).toHaveBeenCalledTimes(1);
        expect(txnConn.commit).not.toHaveBeenCalled();
        expect(txnConn.close).toHaveBeenCalledTimes(1);
    });

    // ── Batch resilience ──────────────────────────────────────────────────

    it("withBatchConnection continues after non-fatal errors in individual ops", async function () {
        const pool = fakePool();
        createPoolStub.mockResolvedValue(pool);

        const operations = [
            async (c) => c.execute("SELECT 1 FROM DUAL"),
            async () => {
                throw new Error("op 1 failed");
            },
            async (c) => c.execute("SELECT 3 FROM DUAL"),
        ];

        const results = await config.withBatchConnection(
            currentPoolName,
            operations,
        );

        expect(results).toHaveLength(3);
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(false);
        expect(results[1].error).toContain("op 1 failed");
        expect(results[2].success).toBe(true);
    });

    it("withBatchConnection reports non-function entries as failures", async function () {
        const pool = fakePool();
        createPoolStub.mockResolvedValue(pool);

        const operations = [
            async (c) => c.execute("SELECT 1 FROM DUAL"),
            "not a function",
            async (c) => c.execute("SELECT 3 FROM DUAL"),
        ];

        const results = await config.withBatchConnection(
            currentPoolName,
            operations,
        );

        expect(results).toHaveLength(3);
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(false);
        expect(results[1].error).toContain("not a function");
        expect(results[2].success).toBe(true);
    });

    // ── Health monitoring ─────────────────────────────────────────────────

    it("isPoolHealthy returns true for a pool that has not been checked", function () {
        const healthy = config.isPoolHealthy(currentPoolName);
        expect(healthy).toBe(true);
    });

    it("getHealthMetrics returns an object", function () {
        const metrics = config.getHealthMetrics();
        expect(metrics).toBeInstanceOf(Object);
    });

    // ── Validation ────────────────────────────────────────────────────────

    it("withConnection rejects with TypeError when callback is not a function", async function () {
        try {
            await config.withConnection(currentPoolName, "not a function");
            expect.fail("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(TypeError);
            expect(err.message).toContain("callback must be a function");
        }
    });

    it("withBatchConnection rejects with TypeError when operations is empty", async function () {
        try {
            await config.withBatchConnection(currentPoolName, []);
            expect.fail("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(TypeError);
            expect(err.message).toContain("non-empty array");
        }
    });

    // ── oracle-mongo-wrapper integration ──────────────────────────────────

    it("createDb produces a db interface bound to the correct pool", function () {
        const { createDb } = require("../../../src/utils/oracle-mongo-wrapper");
        const db = createDb(currentPoolName);

        expect(db).toHaveProperty("connectionName", currentPoolName);
        expect(db.withConnection).toBeInstanceOf(Function);
        expect(db.withTransaction).toBeInstanceOf(Function);
        expect(db.withBatchConnection).toBeInstanceOf(Function);
        expect(db.closePool).toBeInstanceOf(Function);
        expect(db.getPoolStats).toBeInstanceOf(Function);
        expect(db.isHealthy).toBeInstanceOf(Function);
        expect(db.oracledb).toBe(config.oracledb);
    });

    it("createDb withConnection delegates to the adapter correctly", async function () {
        const { createDb } = require("../../../src/utils/oracle-mongo-wrapper");
        const pool = fakePool();
        createPoolStub.mockResolvedValue(pool);

        const db = createDb(currentPoolName);
        const result = await db.withConnection(async (conn) => {
            return conn.execute("SELECT 1 FROM DUAL");
        });

        expect(result).toEqual({ rows: [{ RESULT: 1 }] });
    });

    it("createDb throws TypeError for invalid connection name", function () {
        const { createDb } = require("../../../src/utils/oracle-mongo-wrapper");
        expect(() => createDb("")).toThrow(TypeError);
        expect(() => createDb(null)).toThrow(TypeError);
    });
});
