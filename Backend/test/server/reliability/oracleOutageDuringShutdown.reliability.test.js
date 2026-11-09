"use strict";

/**
 * @fileoverview Gap 3 â€” the database dies DURING a graceful shutdown.
 *
 * Invariant: the shutdown email still leaves, and the draining pools never
 * produce an ORACLE_POOL_DOWN email (nobody should be paged for the shutdown
 * itself). Real fresh Oracle adapter (PoolHealthMonitor + registry), real
 * MetricsStore singleton, real AlertNotifierService poll, real
 * ServerNotificationService rendering; only `createPool` (whose connections
 * start failing) and `sendMail` are stubbed. Fake timers drive the monitor's
 * 30 s / 5 s cadence and the 2 s poll.
 *
 * The control case proves the setup is sensitive: the same outage WITHOUT a
 * shutdown does page ORACLE_POOL_DOWN.
 *
 * Readiness push while draining is covered by healthStreamHub.test.js
 * ("does not evaluate while draining").
 */

const { loadFreshAdapter } = require("../helpers/freshOracleAdapter");
const { AlertNotifierService } = require("../../../src/services/AlertNotifierService");
const ShutdownNotifier = require("../../../src/utils/shutdown/ShutdownNotifier");
const SharedTransporter = require("../../../src/services/email/SharedTransporter");
const RecipientResolver = require("../../../src/services/email/RecipientResolver");
const AdminModel = require("../../../src/models/admin.model");
const ServerAlertLogModel = require("../../../src/models/serverAlertLog.model");
const ServerAlertAckModel = require("../../../src/models/serverAlertAck.model");
const { logger } = require("../../../src/utils/logger");

const DB_DOWN = () => Promise.reject(new Error("NJS-503: connection to host failed"));

describe("Gap 3 â€” DB dies during graceful shutdown", function () {
    const realRandom = Math.random;
    let fresh;
    let notifier;
    let sent;
    let dbUp;

    beforeEach(async function () {
        vi.useFakeTimers();
        Math.random = () => 0;
        vi.stubEnv("ENABLE_SERVER_NOTIFICATIONS", "true");
        vi.stubEnv("SERVER_NOTIFY_TO", "ops@example.com");
        vi.stubEnv("ALERT_POLL_INTERVAL_MS", "2000");
        RecipientResolver.invalidate();

        vi.spyOn(AdminModel, "findServerNotifyRecipients").mockImplementation(DB_DOWN);
        vi.spyOn(AdminModel, "getNamesByIds").mockResolvedValue(new Map());
        vi.spyOn(ServerAlertLogModel, "insertOne").mockImplementation(DB_DOWN);
        vi.spyOn(ServerAlertLogModel, "findRecent").mockResolvedValue([]);
        vi.spyOn(ServerAlertLogModel, "purgeOlderThan").mockResolvedValue(0);
        vi.spyOn(ServerAlertAckModel, "findAll").mockResolvedValue([]);

        sent = [];
        vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockImplementation(async (opts) => {
            sent.push(opts);
            return { messageId: `probe-${sent.length}` };
        });

        dbUp = true;
        const conn = { ping: async () => {}, close: async () => {}, execute: async () => ({ rows: [] }) };
        fresh = loadFreshAdapter({
            createPool: async () => ({
                poolMin: 0, poolMax: 4, connectionsOpen: 1, connectionsInUse: 0, queueLength: 0,
                getConnection: async () => (dbUp ? conn : DB_DOWN()),
                close: async () => {},
            }),
        });
        const init = fresh.adapter.initializePools();
        await vi.advanceTimersByTimeAsync(100);
        await init;

        notifier = new AlertNotifierService();
        expect(notifier.start().started).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
    });

    afterEach(function () {
        notifier.stop();
        if (fresh) fresh.restore();
        fresh = null;
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        Math.random = realRandom;
        RecipientResolver.invalidate();
    });

    const poolDownMails = () => sent.filter((m) => /ORACLE_POOL_DOWN/.test(`${m.subject}\n${m.text}`));

    it("control: the same outage with no shutdown pages ORACLE_POOL_DOWN", async function () {
        dbUp = false;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fresh.adapter.isPoolHealthy("appDb")).toBe(false);
        expect(poolDownMails().length).toBeGreaterThanOrEqual(1);
    });

    it("shutdown email still sent; draining pools raise no ORACLE_POOL_DOWN email", async function () {
        dbUp = false; // DB dies as the stop begins

        // server.js order: AlertNotifierService.beginShutdown -> shutdownNotifier.started -> ... closeAll
        notifier.beginShutdown();
        const shutdownNotifier = new ShutdownNotifier({ alertNotifier: notifier, logger });
        const started = shutdownNotifier.started({ signal: "SIGTERM", inFlight: 0, graceMs: 30_000, pendingTasks: 0 });
        await vi.advanceTimersByTimeAsync(3_000);
        await started;
        // A stop that takes a while with the DB gone: monitor ticks keep running until closeAll.
        await vi.advanceTimersByTimeAsync(60_000);
        await Promise.all([fresh.adapter.closeAll(), vi.advanceTimersByTimeAsync(31_000)]);
        await vi.advanceTimersByTimeAsync(60_000);

        const shutdownMail = sent.find((m) => m.subject.includes("Server shutting down"));
        expect(shutdownMail, `subjects: ${sent.map((m) => m.subject).join(" | ")}`).toBeDefined();
        expect(String(shutdownMail.to)).toBe("ops@example.com");
        expect(poolDownMails(), "ORACLE_POOL_DOWN emailed while draining").toHaveLength(0);
    });
});
